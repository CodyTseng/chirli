import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter, type Event } from 'nostr-tools';

import { localNip17Identity, rumor, wrap, standardEnvelope, generateSecretKey, getPublicKey } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { KeySync } from '../src/key-sync.js';
import type { Transport } from '../src/relay.js';
const url = 'ws://local.invalid';
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transport(overrides: Partial<Transport> = {}): Transport {
  return { query: async () => [], publish: async () => {}, subscribe: () => ({ ready: Promise.resolve(), close() {} }), close() {}, ...overrides };
}
const options = (wire: Transport) => ({ identity: localNip17Identity(), transport: wire, relays: [url], database: ':memory:', keySync: false as const, recovery: false as const, reconnect: false as const });

test('concurrent start calls share readiness and initialization failures', { timeout: 2000 }, async () => {
  for (const failure of [false, true]) {
    const gate = deferred(); let subscriptions = 0, done = 0;
    const wire = transport({ subscribe: () => { subscriptions++; return { ready: gate.promise, close() { gate.resolve(); } }; } });
    const client = new Client(options(wire));
    try {
      const first = client.start(), second = client.start();
      assert.equal(first, second);
      const results = Promise.allSettled([first, second]);
      void second.then(() => { done++; }, () => { done++; });
      await settle(); assert.equal(done, 0); assert.equal(subscriptions, 1);
      if (failure) gate.reject(new Error('initial read failed')); else gate.resolve();
      const outcomes = await results;
      assert.deepEqual(outcomes.map(result => result.status), failure ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
      assert.equal(subscriptions, failure ? 1 : 2);
    } finally { await client.close(); }
  }
});

test('stop cancels pending initialization before a serialized restart', { timeout: 2000 }, async () => {
  const gate = deferred(); let metadata = 0, inbox = 0;
  const wire = transport({ subscribe: (_urls, filter) => {
    if (filter.kinds?.includes(1059)) { inbox++; return { ready: Promise.resolve(), close() {} }; }
    metadata++; return { ready: metadata === 1 ? gate.promise : Promise.resolve(), close() { gate.resolve(); } };
  } });
  const client = new Client(options(wire));
  try {
    const initial = client.start(), stopped = client.stop(), restarted = client.start();
    await Promise.all([initial, stopped, restarted]);
    assert.equal(metadata, 2); assert.equal(inbox, 1, 'the canceled startup must not install an inbox');
  } finally { await client.close(); }
});

test('concurrent close shares teardown, rejects new work and cancels pending startup', { timeout: 2000 }, async () => {
  const gate = deferred(); let closed = 0;
  const wire = transport({ subscribe: () => ({ ready: gate.promise, close() { gate.resolve(); } }), close() { closed++; } });
  const client = new Client(options(wire)), starting = client.start();
  const first = client.close(), second = client.close();
  assert.equal(first, second);
  assert.throws(() => client.history(client.pubkey), /closing/);
  await assert.rejects(client.start(), /closing/);
  await Promise.all([first, second, starting]);
  await client.close(); assert.equal(closed, 0);
  wire.close(); assert.equal(closed, 1);
});

test('handlers reject self-draining stop/close and requestStop lets external shutdown drain work', { timeout: 2000 }, async () => {
  const client = new Client(options(transport())), peer = localNip17Identity(), entered = deferred(), release = deferred();
  let handlerDone = false, drained = false;
  client.handle(async () => {
    await assert.rejects(client.stop(), /requestStop/);
    await assert.rejects(client.close(), /requestStop/);
    client.requestStop(); entered.resolve(); await release.promise; handlerDone = true;
  });
  try {
    await client.start();
    await client.receive(await wrap(rumor(peer.pubkey, client.pubkey, 'stop'), peer, client.pubkey, client.pubkey, standardEnvelope), 'live');
    await entered.promise;
    const stopped = client.stop().then(() => { drained = true; });
    await settle(); assert.equal(drained, false);
    release.resolve(); await stopped;
    assert.equal(handlerDone, true); assert.equal(client.store.pending().length, 0);
    await client.start();
  } finally { release.resolve(); await client.close(); }
});

async function outboxFixture(blockFirst = false) {
  const owner = localNip17Identity(), bad = localNip17Identity(), good = localNip17Identity();
  const snapshots = await Promise.all([[owner, 'ws://self.invalid'], [bad, 'ws://bad.invalid'], [good, 'ws://good.invalid']].map(([identity, relay]) =>
    (identity as typeof owner).sign({ kind: 10050, created_at: 1, tags: [['relay', relay as string]], content: '' })));
  const attempts: { urls: string[]; event: Event }[] = [], blocked = deferred(), release = deferred();
  let offline = true, first = true;
  const wire = transport({ query: async (_urls, filter) => snapshots.filter(event => matchFilter(filter, event)), publish: async (urls, event) => {
    attempts.push({ urls, event });
    if (urls.includes('ws://bad.invalid') && offline) {
      if (blockFirst && first) { first = false; blocked.resolve(); await release.promise; }
      throw new Error('offline');
    }
  } });
  const client = new Client({ ...options(wire), identity: owner });
  return { client, bad, good, attempts, blocked, release, recover() { offline = false; } };
}

test('an unreachable recipient does not block another conversation or change exact retry envelopes', { timeout: 2000 }, async () => {
  const f = await outboxFixture();
  try {
    const failed = await f.client.send(f.bad.pubkey, 'offline recipient'); assert.equal(failed.status, 'pending');
    const original = JSON.stringify(f.client.store.outbox()[0].events);
    const success = await f.client.send(f.good.pubkey, 'healthy recipient'); assert.equal(success.status, 'relay-accepted');
    assert.equal(f.client.store.outbox().length, 1);
    assert.equal(JSON.stringify(f.client.store.outbox()[0].events), original);
    assert.ok(f.attempts.some(attempt => attempt.urls.includes('ws://good.invalid')));
    await assert.rejects(f.client.flushOutbox(), AggregateError);
    f.recover(); await f.client.flushOutbox(); assert.equal(f.client.store.outbox().length, 0);
    assert.equal(new Set(f.attempts.filter(attempt => attempt.urls.includes('ws://bad.invalid')).map(attempt => attempt.event.id)).size, 1);
  } finally { await f.client.close(); }
});

test('a caller arriving during a failed flush still sends its newly committed message', { timeout: 2000 }, async () => {
  const f = await outboxFixture(true);
  try {
    const bad = f.client.send(f.bad.pubkey, 'blocked first flush'); await f.blocked.promise;
    const good = f.client.send(f.good.pubkey, 'new message'); await settle();
    assert.equal(f.client.store.outbox().length, 2);
    f.release.resolve();
    const [failed, accepted] = await Promise.all([bad, good]);
    assert.equal(failed.status, 'pending'); assert.equal(accepted.status, 'relay-accepted');
  } finally { f.release.resolve(); await f.client.close(); }
});

for (const stage of ['sign', 'publish'] as const) for (const action of ['stop', 'timeout'] as const) {
  test(`key sync ${action} cancels a pending ${stage} without waiting for its late completion`, { timeout: 2000 }, async ctx => {
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = localNip17Identity(), store = new Store(':memory:', undefined, 'cancel-review'), gate = deferred(), entered = deferred();
    let publications = 0, closed = 0;
    const identity = { ...owner, sign: async (template: Parameters<typeof owner.sign>[0]) => {
      if (stage === 'sign') { entered.resolve(); await gate.promise; }
      return owner.sign(template);
    } };
    const expected = getPublicKey(generateSecretKey());
    const wire = transport({ subscribe: () => ({ ready: Promise.resolve(), close() { closed++; } }), publish: async () => {
      publications++; if (stage === 'publish') { entered.resolve(); await gate.promise; }
    } });
    const sync = new KeySync(identity, store, wire, [url], () => undefined, () => expected, { timeoutMs: 100 });
    try {
      const request = sync.request(expected), rejected = assert.rejects(request, action === 'stop' ? /stopped/ : /timed out/);
      await entered.promise;
      if (action === 'stop') sync.stop(); else ctx.mock.timers.tick(100);
      await rejected; await sync.idle(); assert.equal(closed, 1);
      if (action === 'stop') sync.start(); // Restart must not revive canceled work.
      gate.resolve(); await settle();
      assert.equal(publications, stage === 'sign' ? 0 : 1);
    } finally { gate.resolve(); sync.stop(); await sync.idle(); store.close(); }
  });
}

test('a stopped Bot rejects DM, public, and own-copy input without consuming their IDs', async () => {
  const owner = localNip17Identity(), peer = localNip17Identity();
  const client = new Client({ ...options(transport()), identity: owner, publicInbox: { relays: [url] } });
  client.registerCommandDefinition({id:'run',command:'run',title:'Run',description:'Run',scopes:['kind:1']});
  let dm = 0, pub = 0;
  client.handle(() => { dm++; });
  client.handlePublic(async () => { pub++; });
  const note = await peer.sign({kind:1,content:'/run',tags:[['p',owner.pubkey]],created_at:Math.floor(Date.now()/1000)});
  try {
    assert.equal(await client.receive(note,'live',{relay:url}),false,'not started yet');
    await client.start();
    const incoming = await wrap(rumor(peer.pubkey,owner.pubkey,'post-stop DM'),peer,owner.pubkey,owner.pubkey,standardEnvelope);
    const self = await wrap(rumor(owner.pubkey,peer.pubkey,'self copy'),owner,owner.pubkey,owner.pubkey,standardEnvelope);
    await client.stop();
    for(const source of ['live','history'] as const) {
      assert.equal(await client.receive(incoming,source),false);
      assert.equal(await client.receive(self,source),false);
      assert.equal(await client.receive(note,source,{relay:url}),false);
    }
    await assert.rejects(client.syncHistory(),/Start the client/);
    assert.deepEqual(client.history(peer.pubkey).messages,[]);
    assert.deepEqual([dm,pub],[0,0]);
    await client.start();
    assert.equal(await client.receive(incoming,'live'),true);
    assert.equal(await client.receive(note,'live',{relay:url}),true);
    assert.equal(await client.receive(self,'history'),true);
    await client.idle();
    assert.deepEqual([dm,pub],[1,1]);
    assert.equal(client.history(peer.pubkey).messages.length,2);
  } finally { await client.close(); }
});

for (const rejectDecrypt of [false,true]) test(`a canceled async decrypt cannot ${rejectDecrypt?'report or ':''}claim an input across stop/restart`, {timeout:2000}, async () => {
  const owner=localNip17Identity(), peer=localNip17Identity(), entered=deferred(), release=deferred();
  const local=owner.identityEncryption!;
  let decrypts=0, calls=0, reports=0;
  const identity={...owner,identityEncryption:{...local,asynchronous:true,async decrypt(text:string,key:string) {
    if(++decrypts===1) { entered.resolve();await release.promise; }
    return local.decrypt(text,key);
  }}};
  const client=new Client({...options(transport()),identity});
  client.handle(()=>{calls++;});
  client.onError(()=>{reports++;});
  try {
    await client.start();
    const incoming=await wrap(rumor(peer.pubkey,owner.pubkey,'pending decrypt'),peer,owner.pubkey,owner.pubkey,standardEnvelope);
    const slow=client.receive(incoming,'live');
    await entered.promise;
    const queued=client.receive(incoming,'history');
    const stopped=client.stop(), restarted=client.start();
    assert.equal(await client.receive(incoming,'live'),false);
    if(rejectDecrypt) release.reject(new Error('late signer failure'));
    else release.resolve();
    assert.deepEqual(await Promise.all([slow,queued]),[false,false]);
    await stopped;await restarted;
    assert.equal(calls,0);
    assert.equal(reports,0);
    assert.equal(decrypts,1,'stop prevents a second signer decrypt and skips the queued copy');
    assert.equal(await client.receive(incoming,'live'),true);
    await client.idle();
    assert.equal(calls,1);
  } finally { release.resolve();await client.close(); }
});

test('stale transport callbacks cannot update metadata or deliver DM before or after restart', async () => {
  const owner=localNip17Identity(), peer=localNip17Identity();
  const callbacks:{metadata?: (event:Event, source:'live')=>void; dm?: (event:Event, source:'live')=>void}[]=[{},{}];
  let generation=0, calls=0;
  const wire=transport({subscribe:(_relays,filter,receive)=>{
    if(filter.kinds?.includes(1059))callbacks[generation].dm=receive;
    if(filter.kinds?.includes(10044)&&filter.kinds.includes(4454))callbacks[generation].metadata=receive;
    return {ready:Promise.resolve(),close(){}};
  }});
  const client=new Client({...options(wire),identity:owner});
  client.handle(()=>{calls++;});
  try{
    await client.start();
    const dm=await wrap(rumor(peer.pubkey,owner.pubkey,'late transport callback'),peer,owner.pubkey,owner.pubkey,standardEnvelope);
    const before=client.store.declaration(owner.pubkey);
    const newer=await owner.sign({kind:10044,created_at:(before?.created_at??Math.floor(Date.now()/1000))+10,content:'',tags:[['n',owner.pubkey]]});
    await client.stop();
    callbacks[0].metadata!(newer,'live');
    callbacks[0].dm!(dm,'live');
    await settle();
    assert.equal(client.store.declaration(owner.pubkey)?.id,before?.id);
    assert.equal(calls,0);
    generation++;
    await client.start();
    const afterRestart=client.store.declaration(owner.pubkey);
    callbacks[0].metadata!(newer,'live');
    callbacks[0].dm!(dm,'live');
    await settle();
    assert.equal(client.store.declaration(owner.pubkey)?.id,afterRestart?.id);
    assert.equal(calls,0);
    callbacks[1].metadata!(newer,'live');
    callbacks[1].dm!(dm,'live');
    await client.idle();
    assert.equal(client.store.declaration(owner.pubkey)?.id,newer.id);
    assert.equal(calls,1);
  }finally{await client.close();}
});
