import { localIdentity, localNip17Identity } from '../src/protocol.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { finalizeEvent, getEventHash, nip44, type Event } from 'nostr-tools';
import { generateSecretKey, getPublicKey, WebSocketTransport, type ProtocolMode, type Transport } from '../src/index.js';
import { rumor, unwrap, wrap } from '../src/protocol.js';
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('condition timeout');
}
const noSubscription = () => ({ ready: Promise.resolve(), close() {} });

for (const mode of ['nip4e', 'nip17'] as const) {
  test(`${mode}: concurrent send drains rows committed during an earlier ACK wait`, async () => {
    const identity = mode === 'nip17' ? localNip17Identity : localIdentity;
    const a = identity(), b = identity(), relays = ['ws://memory.invalid'];
    const metadata = await Promise.all([a, b].flatMap(owner => [
      owner.sign({ kind: 10044, created_at: 10, tags: [['n', getPublicKey(owner.encryptionKey)]], content: '' }),
      owner.sign({ kind: 10050, created_at: 10, tags: [['relay', relays[0]]], content: '' }),
    ]));
    let release!: () => void, publishing = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const published: Event[] = [];
    const transport: Transport = {
      query: async () => metadata, subscribe: noSubscription, close() {},
      publish: async (_relays, event) => { publishing = true; await gate; published.push(event); },
    };
    const client = new Client({mode, identity: a, relays, transport, database: ':memory:', storageKey: generateSecretKey() });
    try {
      const first = client.send(b.pubkey, 'first'); await until(() => publishing);
      const second = client.send(b.pubkey, 'second'); await until(() => client.store.outbox().length === 2);
      release(); const results = await Promise.all([first, second]);
      assert.ok(results.every(result => result.status === 'relay-accepted'));
      assert.equal(client.store.outbox().length, 0); assert.equal(published.length, 4);
      assert.equal(new Set(published.map(event => event.id)).size, 4);
    } finally { release(); await client.close(); }
  });
}

test('concurrent duplicate receipts cannot execute a failing rumor twice', async () => {
  const receiver = localIdentity(), sender = localIdentity();
  const transport: Transport = { query: async () => [], subscribe: noSubscription, publish: async () => {}, close() {} };
  const client = new Client({mode:'nip4e', identity: receiver, relays: ['ws://memory.invalid'], transport, database: ':memory:', storageKey: generateSecretKey() });
  let attempts = 0, observed = 0;
  client.onError(async () => { observed++; throw new Error('monitor failure must not escape'); });
  client.handle(async () => { attempts++; throw new Error('business failure'); });
  try {
    await client.start();
    const event = await wrap(rumor(sender.pubkey, receiver.pubkey, 'retry once'), sender, receiver.pubkey, getPublicKey(receiver.encryptionKey));
    assert.deepEqual(await Promise.all([client.receive(event,'live'),client.receive(event,'live')]),[true,false]);
    await client.idle(); assert.equal(attempts,1); assert.equal(observed,1);
    await client.stop(); await client.start(); assert.equal(await client.receive(event,'live'),false);
    assert.equal(attempts,1);
  } finally { await client.close(); }
});

test('authenticated resubscription ignores pre-activation DMs but admits an eligible DM after EOSE', async t => {
  const receiver = localIdentity(), sender = localIdentity(), now = Date.now();
  t.mock.method(Date,'now',()=>now);
  const old = await wrap(rumor(sender.pubkey, receiver.pubkey, '/old', now - 60_000), sender, receiver.pubkey, getPublicKey(receiver.encryptionKey));
  const live = await wrap(rumor(sender.pubkey, receiver.pubkey, 'new', now + 1), sender, receiver.pubkey, getPublicKey(receiver.encryptionKey));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  server.on('connection', ws => {
    let requests = 0;
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame[0] === 'AUTH') ws.send(JSON.stringify(['OK', frame[1].id, true, 'authenticated']));
      if (frame[0] !== 'REQ') return;
      if (++requests === 1) {
        ws.send(JSON.stringify(['EOSE', frame[1]]));
        ws.send(JSON.stringify(['AUTH', 'later-authentication']));
      } else {
        ws.send(JSON.stringify(['EVENT', frame[1], old]));
        ws.send(JSON.stringify(['EOSE', frame[1]]));
        ws.send(JSON.stringify(['EVENT', frame[1], live]));
      }
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({mode:'nip4e', recovery: false, reconnect: false, identity: receiver, relays: [url], database: ':memory:', storageKey: generateSecretKey() });
  const handled: string[] = []; client.handle(message => { handled.push(message.text); });
  try {
    await client.start(); await until(() => handled.length === 1); await client.idle();
    assert.deepEqual(handled, ['new']);
    assert.deepEqual(client.history(sender.pubkey).messages.map(message=>message.text), ['new']);
    assert.equal(await client.receive(old,'live'),false);
  } finally { await client.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('fractional, negative and unsafe signed timestamps are rejected before storage', async () => {
  const sender = localIdentity(), receiver = localIdentity();
  const encrypt = (value: unknown, secret: Uint8Array, peer: string) => nip44.v2.encrypt(JSON.stringify(value), nip44.v2.utils.getConversationKey(secret, peer));
  const base = rumor(sender.pubkey, receiver.pubkey, 'time boundary');
  for (const invalidTime of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
    for (const layer of ['rumor', 'seal', 'giftwrap']) {
      const r = { ...base, created_at: layer === 'rumor' ? invalidTime : base.created_at }; r.id = getEventHash(r);
      const seal = await sender.sign({ kind: 13, created_at: layer === 'seal' ? invalidTime : base.created_at, tags: [['n', getPublicKey(sender.encryptionKey)]], content: encrypt(r, sender.encryptionKey, getPublicKey(receiver.encryptionKey)) });
      const key = generateSecretKey();
      const event = finalizeEvent({ kind: 1059, created_at: layer === 'giftwrap' ? invalidTime : base.created_at, tags: [['p', receiver.pubkey]], content: encrypt(seal, key, getPublicKey(receiver.encryptionKey)) }, key);
      assert.equal(unwrap(event, receiver), undefined, `${layer}: ${invalidTime}`);
    }
  }
});

test('history rejects malformed cursors and nonintegral limits with bounded inputs', async () => {
  const client = new Client({mode:'nip4e', identity: localIdentity(), relays: ['ws://unused.invalid'], database: ':memory:', storageKey: generateSecretKey() });
  try {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => client.history(client.pubkey, { limit }), /positive safe integer/);
    for (const cursor of ['', '%%%', 'x'.repeat(257), Buffer.from(JSON.stringify([1, 'not-an-id'])).toString('base64url')]) {
      assert.throws(() => client.history(client.pubkey, { cursor }), /Invalid history cursor/);
    }
    assert.deepEqual(client.history(client.pubkey, { limit: 1000 }).messages, []);
  } finally { await client.close(); }
});

test('a negative or unrelated relay ACK cannot acknowledge publication', async () => {
  for (const reply of ['negative', 'unrelated']) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', resolve));
    server.on('connection', ws => ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      ws.send(JSON.stringify(['OK', reply === 'unrelated' ? '0'.repeat(64) : frame[1].id, reply !== 'negative', 'test']));
    }));
    const transport = new WebSocketTransport(100);
    const event = finalizeEvent({ kind: 1, created_at: 10, tags: [], content: 'disposable ACK test' }, generateSecretKey());
    try {
      await assert.rejects(transport.publish([`ws://127.0.0.1:${(server.address() as { port: number }).port}`], event));
    } finally { transport.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});


test('synchronous transport startup failures leave the client restartable', async () => {
  let subscriptions = 0;
  const transport: Transport = {
    query: async () => [], publish: async () => {}, close() {},
    subscribe: () => { if (++subscriptions === 1) throw new Error('startup failed'); return noSubscription(); },
  };
  const client = new Client({mode:'nip4e',recovery:false,identity:localIdentity(),relays:['ws://unused.invalid'],transport,database:':memory:',storageKey:generateSecretKey()});
  try {
    await assert.rejects(client.start(), /startup failed/);
    await client.start(); assert.equal(subscriptions, 3);
  } finally { await client.close(); }
});


test('post-AUTH EOSE timeouts report disconnect after initial ready has resolved', async () => {
  const identity = localIdentity();
  const server = new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise<void>(resolve => server.once('listening', resolve));
  server.on('connection', ws => {
    let requests = 0;
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame[0] === 'REQ' && ++requests === 1) {
        ws.send(JSON.stringify(['EOSE', frame[1]])); ws.send(JSON.stringify(['AUTH','timeout-after-ready']));
      }
      if (frame[0] === 'AUTH') ws.send(JSON.stringify(['OK',frame[1].id,true,'accepted']));
      // Intentionally omit EOSE for the authenticated replacement subscription.
    });
  });
  const transport = new WebSocketTransport(100, template => identity.sign(template));
  const failures: Error[] = [];
  const sub = transport.subscribe([`ws://127.0.0.1:${(server.address() as {port:number}).port}`], {kinds:[1059],'#p':[identity.pubkey]}, () => {}, error => {failures.push(error);});
  try {
    await sub.ready; await until(() => failures.length > 0);
    assert.equal(failures.length,1); assert.match(failures[0].message,/EOSE timeout/);
  } finally { sub.close(); transport.close(); for(const ws of server.clients)ws.terminate(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
