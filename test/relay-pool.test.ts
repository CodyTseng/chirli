import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { RelayPool, DEFAULT_RELAY_TIMEOUTS, type RelayTimeouts } from '../src/relay-pool.js';
import { WebSocketTransport } from '../src/relay.js';
import { localNip17Identity } from '../src/protocol.js';
import { RelayError } from '../src/errors.js';

class Socket extends EventEmitter {
  readyState = 0;
  sent: unknown[][] = [];
  pings = 0;
  static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  onopen: (() => void) | null = null;
  onclose: ((event: {message: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  ping() { this.pings++; }
  open() { this.readyState = 1; this.emit('open'); this.onopen?.(); }
  raw(data: string) { this.emit('message', Buffer.from(data)); this.onmessage?.({data}); }
  frame(frame: unknown[]) { this.raw(JSON.stringify(frame)); }
  close() { this.terminate(); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1006); this.onclose?.({message: 'closed'}); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const url = 'ws://relay.invalid';
function fixture(options: Partial<RelayTimeouts> = {}, signer?: ConstructorParameters<typeof WebSocketTransport>[1]) {
  const timeouts = { ...DEFAULT_RELAY_TIMEOUTS, ...options }, sockets: Socket[] = [], addresses: string[] = [];
  const wire = new WebSocketTransport(timeouts, signer);
  const pool = new RelayPool(timeouts, signer, address => { addresses.push(address); const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
  Reflect.set(wire, 'pool', pool);
  return { wire, sockets, addresses, get socket() { return sockets.at(-1)!; } };
}
function req(socket: Socket, index = 0) { return socket.sent.filter(frame => frame[0] === 'REQ')[index][1]; }
const timeout = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;

test('default phase budgets and legacy numeric override are validated', () => {
  const wire = new WebSocketTransport();
  assert.equal(wire.timeouts.connectionTimeoutMs, 5000);
  assert.equal(wire.timeouts.eoseTimeoutMs, 25000);
  assert.equal(wire.timeouts.authTimeoutMs, 8000);
  assert.equal(wire.timeouts.publishTimeoutMs, 5000);
  assert.equal(new WebSocketTransport(100).timeouts.eoseTimeoutMs, 100);
  for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new WebSocketTransport(value), TypeError);
  wire.close();
});

test('queries, live subscriptions and concurrent publications share one connection and release independently', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture({ idleTimeoutMs: 100 }), identity = localNip17Identity();
  const received: string[] = [];
  const live = f.wire.subscribe([url], { kinds: [1] }, (_event, source) => received.push(source));
  const query = f.wire.query([url, `${url}/`], { kinds: [2] });
  const event = await identity.sign({ kind: 1, created_at: 1, tags: [], content: 'test' });
  const publications = Promise.all([f.wire.publish([url], event), f.wire.publish([url], event)]);
  try {
    assert.equal(f.sockets.length, 1);
    f.socket.open(); await settle();
    f.socket.frame(['EOSE', req(f.socket)]);
    for (const request of f.socket.sent.filter(frame => frame[0] === 'REQ').slice(1)) f.socket.frame(['EOSE', request[1]]);
    f.socket.frame(['OK', event.id, true]);
    await live.ready; assert.deepEqual(await query, []); await publications;
    assert.equal(f.socket.sent.filter(frame => frame[0] === 'EVENT').length, 1, 'same-ID concurrent publication shares the library ACK slot');
    f.socket.frame(['EVENT', req(f.socket), event]); assert.deepEqual(received, ['live']);
    ctx.mock.timers.tick(101); assert.equal(f.socket.readyState, 1, 'live demand retains connection');
    live.close();
    const next = f.wire.query([url], { kinds: [3] }); await settle();
    f.socket.frame(['EOSE', f.socket.sent.filter(frame => frame[0] === 'REQ').at(-1)![1]]); await next;
    assert.equal(f.sockets.length, 1, 'idle connection reused');
    ctx.mock.timers.tick(101); assert.equal(f.socket.readyState, 3, 'unused socket evicted');
  } finally { live.close(); f.wire.close(); }
});

test('connection, EOSE and ACK have separate deadlines; one slow read does not close another subscription', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture({ connectionTimeoutMs: 50, eoseTimeoutMs: 200, publishTimeoutMs: 80 });
  try {
    const stalled = f.wire.subscribe([url], {}, () => {}), rejected = assert.rejects(stalled.ready, timeout('RELAY_CONNECT_TIMEOUT'));
    ctx.mock.timers.tick(50); await rejected;
    const live = f.wire.subscribe([url], { kinds: [1] }, () => {});
    f.socket.open(); await settle(); f.socket.frame(['EOSE', req(f.socket)]); await live.ready;
    const query = f.wire.query([url], { kinds: [2] }), pending = assert.rejects(query, timeout('RELAY_EOSE_TIMEOUT'));
    await settle(); ctx.mock.timers.tick(199); assert.equal(f.socket.readyState, 1);
    ctx.mock.timers.tick(1); await pending; assert.equal(f.socket.readyState, 1);
    const identity = localNip17Identity(), event = await identity.sign({ kind: 1, created_at: 1, tags: [], content: '' });
    const publishing = assert.rejects(f.wire.publish([url], event), (error: unknown) => error instanceof AggregateError && error.errors[0].code === 'RELAY_ACK_TIMEOUT');
    await settle(); ctx.mock.timers.tick(80); await publishing;
    assert.equal(f.socket.readyState, 1); live.close();
  } finally { f.wire.close(); }
});

test('one AUTH handshake restores all reads and retries the exact publication; replay stays historical until EOSE', async () => {
  const identity = localNip17Identity(); let signatures = 0;
  const f = fixture({}, async template => { signatures++; return identity.sign(template); });
  const sources: string[] = [];
  const first = f.wire.subscribe([url], { kinds: [1] }, (_event, source) => sources.push(source));
  const second = f.wire.subscribe([url], { kinds: [2] }, () => {});
  const event = await identity.sign({ kind: 1, created_at: 1, tags: [], content: '' });
  const publication = f.wire.publish([url], event);
  try {
    f.socket.open(); await settle();
    f.socket.frame(['EOSE', req(f.socket)]); f.socket.frame(['EOSE', req(f.socket, 1)]);
    await Promise.all([first.ready, second.ready]);
    f.socket.frame(['AUTH', 'challenge']); f.socket.frame(['AUTH', 'challenge']);
    f.socket.frame(['OK', event.id, false, 'auth-required: login']); await settle();
    const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')![1] as { id: string };
    assert.equal(signatures, 1);
    f.socket.frame(['OK', auth.id, true]); await settle();
    const replacement = f.socket.sent.filter(frame => frame[0] === 'REQ' && (frame[2] as {kinds:number[]}).kinds?.includes(1)).at(-1)![1];
    f.socket.frame(['EVENT', replacement, event]); assert.deepEqual(sources, ['history']);
    f.socket.frame(['EOSE', replacement]); f.socket.frame(['EVENT', replacement, event]);
    assert.deepEqual(sources, ['history', 'live']);
    assert.deepEqual(f.socket.sent.filter(frame => frame[0] === 'EVENT').map(frame => frame[1]), [JSON.parse(JSON.stringify(event)), JSON.parse(JSON.stringify(event))]);
    f.socket.frame(['OK', event.id, true]); await publication;
  } finally { first.close(); second.close(); f.wire.close(); }
});

test('heartbeat recycles silent connections, fences old frames and permits a fresh generation', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 20 });
  const errors: Error[] = [], sources: string[] = [];
  const sub = f.wire.subscribe([url], {}, (_event, source) => sources.push(source), error => errors.push(error));
  try {
    const old = f.socket; old.open(); await settle(); old.frame(['EOSE', req(old)]); await sub.ready;
    ctx.mock.timers.tick(100); assert.equal(old.pings, 1);
    old.emit('pong'); ctx.mock.timers.tick(100); await settle(); assert.equal(old.pings, 2);
    ctx.mock.timers.tick(20); await settle(); assert.equal(errors.length, 1); assert.equal(old.readyState, 3);
    old.frame(['EVENT', req(old), {}]); assert.equal(sources.length, 0);
    const next = f.wire.subscribe([url], {}, () => {}); assert.equal(f.sockets.length, 2);
    f.socket.open(); await settle(); f.socket.frame(['EOSE', req(f.socket)]); await next.ready; next.close();
  } finally { sub.close(); f.wire.close(); }
});

test('close rejects pending operations, cancels timers and never opens new connections', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  const query = assert.rejects(f.wire.query([url], {}), timeout('RELAY_CLOSED'));
  await settle(); f.wire.close(); await query;
  ctx.mock.timers.tick(100000); assert.equal(f.socket.readyState, 3);
  await assert.rejects(f.wire.query([url], {}), timeout('RELAY_CLOSED'));
  assert.equal(f.sockets.length, 1);
});

test('AUTH signing timeout settles all sharing operations and ignores late signatures', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let sign!: (event: Awaited<ReturnType<ReturnType<typeof localNip17Identity>['sign']>>) => void;
  const f = fixture({ authTimeoutMs: 100 }, () => new Promise(resolve => { sign = resolve; }));
  const first = f.wire.query([url], {}), second = f.wire.query([url], {});
  const rejected = [assert.rejects(first, timeout('RELAY_AUTH_TIMEOUT')), assert.rejects(second, timeout('RELAY_AUTH_TIMEOUT'))];
  try {
    await settle(); f.socket.open(); await settle(); f.socket.frame(['AUTH', 'never-completes']);
    ctx.mock.timers.tick(100); await Promise.all(rejected);
    const identity = localNip17Identity(); sign(await identity.sign({ kind: 22242, created_at: 1, tags: [], content: '' })); await settle();
    assert.equal(f.socket.sent.some(frame => frame[0] === 'AUTH'), false);
  } finally { f.wire.close(); }
});

test('query concurrency is bounded per relay and close settles queued work', async () => {
  const f = fixture();
  const queries = Array.from({ length: 8 }, (_, index) => f.wire.query([index % 2 ? url : `${url}/`], { kinds: [index] }));
  const results = queries.map(query => query.then(() => 'ok', error => error.code));
  try {
    await settle(); f.socket.open(); await settle();
    assert.equal(f.sockets.length, 1);
    assert.equal(f.socket.sent.filter(frame => frame[0] === 'REQ').length, 5);
    f.socket.frame(['EOSE', req(f.socket)]); await settle();
    assert.equal(f.socket.sent.filter(frame => frame[0] === 'REQ').length, 6, 'one freed slot admits one query');
    f.wire.close();
    assert.deepEqual(await Promise.all(results), ['ok', ...Array(7).fill('RELAY_CLOSED')]);
    await assert.rejects(f.wire.query([url], {}), timeout('RELAY_CLOSED'));
  } finally { f.wire.close(); }
});

test('work acquired during AUTH waits for authentication before starting its ACK budget', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const identity = localNip17Identity(), f = fixture({ publishTimeoutMs: 50, authTimeoutMs: 200 }, template => identity.sign(template));
  const first = f.wire.subscribe([url], {}, () => {});
  try {
    f.socket.open(); await settle(); f.socket.frame(['EOSE', req(f.socket)]); await first.ready;
    f.socket.frame(['AUTH', 'slow-approval']); await settle();
    const event = await identity.sign({ kind: 1, created_at: 1, tags: [], content: '' });
    const publication = f.wire.publish([url], event); await settle();
    ctx.mock.timers.tick(100);
    assert.equal(f.socket.sent.filter(frame => frame[0] === 'EVENT').length, 0);
    const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')![1] as { id: string };
    f.socket.frame(['OK', auth.id, true]); await settle();
    assert.equal(f.socket.sent.filter(frame => frame[0] === 'EVENT').length, 1);
    f.socket.frame(['OK', event.id, true]); await publication;
  } finally { first.close(); f.wire.close(); }
});

test('canceling the last connecting lease aborts the handshake without reconnect demand', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(), first = f.wire.subscribe([url], {}, () => {}), second = f.wire.subscribe([url], {}, () => {});
  first.close(); assert.equal(f.socket.readyState, 0);
  second.close(); await Promise.all([first.ready, second.ready]);
  assert.equal(f.socket.readyState, 3); ctx.mock.timers.tick(100000); assert.equal(f.sockets.length, 1);
  f.wire.close();
});

for (const operation of ['query', 'publish'] as const) test(`repeated auth-required frames cannot renew a ${operation} AUTH deadline`, async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const identity = localNip17Identity(), f = fixture({ authTimeoutMs: 100, eoseTimeoutMs: 200, publishTimeoutMs: 200 }, template => identity.sign(template));
  const event = await identity.sign({ kind: 1, created_at: 1, tags: [], content: '' });
  const pending = operation === 'query' ? f.wire.query([url], {}) : f.wire.publish([url], event);
  const rejected = assert.rejects(pending, (error: unknown) => operation === 'query' ? timeout('RELAY_AUTH_TIMEOUT')(error) : error instanceof AggregateError && timeout('RELAY_AUTH_TIMEOUT')(error.errors[0]));
  try {
    await settle(); f.socket.open(); await settle();
    const frame = operation === 'query' ? ['CLOSED', req(f.socket), 'auth-required: login'] : ['OK', event.id, false, 'auth-required: login'];
    f.socket.frame(frame); await settle(); ctx.mock.timers.tick(90); f.socket.frame(frame); await settle(); ctx.mock.timers.tick(10);
    await rejected;
  } finally { f.wire.close(); }
});

test('successful AUTH loops cannot extend the total initial-read budget or complete through a stale EOSE', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const identity = localNip17Identity(), f = fixture({ eoseTimeoutMs: 200, authTimeoutMs: 100 }, template => identity.sign(template));
  const query = f.wire.query([url], {}), rejected = assert.rejects(query, timeout('RELAY_EOSE_TIMEOUT'));
  let completed = false; void query.then(() => { completed = true; }, () => {});
  try {
    await settle(); f.socket.open(); await settle();
    for (let i = 0; i < 9; i++) {
      f.socket.frame(['AUTH', `challenge-${i}`]);
      f.socket.frame(['EOSE', req(f.socket)]); // A response to the old read must not finish authentication.
      await settle(); assert.equal(completed, false);
      const auth = f.socket.sent.filter(frame => frame[0] === 'AUTH').at(-1)![1] as { id: string };
      f.socket.frame(['OK', auth.id, true]); ctx.mock.timers.tick(30); await settle();
    }
    ctx.mock.timers.tick(30); await rejected;
  } finally { f.wire.close(); }
});

test('changing AUTH challenges cannot renew the shared connection authentication deadline', async ctx => {
  ctx.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const identity = localNip17Identity(), f = fixture({ authTimeoutMs: 100 }, template => identity.sign(template));
  const query = f.wire.query([url], {}), rejected = assert.rejects(query, timeout('RELAY_AUTH_TIMEOUT'));
  try {
    await settle(); f.socket.open(); await settle();
    f.socket.frame(['AUTH', 'first']); await settle(); ctx.mock.timers.tick(60);
    f.socket.frame(['AUTH', 'second']); await settle(); ctx.mock.timers.tick(40);
    await rejected; assert.equal(f.socket.readyState, 3);
  } finally { f.wire.close(); }
});


test('only boolean true ACK is accepted, including AUTH, and a fresh AUTH challenge is signed independently', async () => {
 const identity = localNip17Identity(), f = fixture({}, template => identity.sign(template));
 const exact = 'ws://relay.invalid/a//b?z=2&a=1', sub = f.wire.subscribe([exact], {}, () => {});
 try {
  f.socket.open(); await settle(); f.socket.frame(['EOSE', req(f.socket)]); await sub.ready;
  assert.deepEqual(f.addresses, [exact]);
  for (const challenge of ['first', 'second']) {
   f.socket.frame(['AUTH', challenge]); await settle();
   const event = f.socket.sent.filter(frame => frame[0] === 'AUTH').at(-1)![1] as {id:string;tags:string[][]};
   assert.ok(event.tags.some(tag => tag[0] === 'relay' && tag[1] === exact));
   assert.ok(event.tags.some(tag => tag[0] === 'challenge' && tag[1] === challenge));
   f.socket.frame(['OK', event.id, true]); await settle();
   f.socket.frame(['EOSE', req(f.socket)]);
  }
  assert.equal(f.socket.sent.filter(frame => frame[0] === 'AUTH').length, 2);
  const event = await identity.sign({kind:1,created_at:1,tags:[],content:'ack-test'});
  const publication = assert.rejects(f.wire.publish([exact], event), (error:unknown) => error instanceof AggregateError && error.errors[0].code === 'RELAY_EVENT_REJECTED');
  await settle(); f.socket.frame(['OK', event.id, 'true']); await publication;
  f.socket.frame(['AUTH', 'malformed-ack']); await settle();
  const auth = f.socket.sent.filter(frame => frame[0] === 'AUTH').at(-1)![1] as {id:string};
  f.socket.frame(['OK', auth.id, 1]); await settle();
  assert.equal(f.socket.readyState, 3, 'malformed AUTH acceptance fails closed');
 } finally { sub.close(); f.wire.close(); }
});

test('strict pages reject filtered or invalid EVENT entries instead of declaring a shorter complete page', async () => {
 const f = fixture(), identity = localNip17Identity();
 const query = f.wire.query([url], {kinds:[1]}), rejected = assert.rejects(query, timeout('RELAY_HISTORY_INCOMPLETE'));
 try {
  await settle(); f.socket.open(); await settle();
  const id = req(f.socket), event = await identity.sign({kind:1,created_at:1,tags:[],content:'valid'});
  f.socket.frame(['EVENT', id, event]);
  f.socket.frame(['EVENT', id, {...event,content:'forged'}]);
  f.socket.frame(['EVENT', id, null]);
  f.socket.frame(['EOSE', id]); await rejected;
  assert.equal(f.socket.readyState, 1, 'strict page failure does not imply socket failure');
 } finally { f.wire.close(); }
});


test('challenge-only AUTH resends the original EVENT once while retaining one shared library ACK slot', async () => {
 const identity = localNip17Identity(), f = fixture({}, template => identity.sign(template));
 const event = await identity.sign({kind:1,created_at:1,tags:[],content:'challenge-only'});
 const pending = Promise.all([f.wire.publish([url], event), f.wire.publish([url], event)]);
 try {
  f.socket.open(); await settle();
  assert.equal(f.socket.sent.filter(frame => frame[0] === 'EVENT').length, 1);
  f.socket.frame(['AUTH', 'challenge-only']); await settle();
  const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')![1] as {id:string};
  f.socket.frame(['OK', auth.id, true]); await settle();
  const writes = f.socket.sent.filter(frame => frame[0] === 'EVENT');
  assert.equal(writes.length, 2, 'AUTH OK must resend even without a rejection ACK for the old EVENT');
  assert.deepEqual(writes.map(frame => frame[1]), [JSON.parse(JSON.stringify(event)), JSON.parse(JSON.stringify(event))]);
  f.socket.frame(['OK', event.id, true]); await pending;
 } finally { f.wire.close(); }
});

test('AUTH replacement queries fence old EOSE and isolate page buffers and counters', async () => {
 const identity = localNip17Identity(), f = fixture({}, template => identity.sign(template));
 const event = await identity.sign({kind:1,created_at:1,tags:[],content:'same event across AUTH'});
 let completed = false;
 const pending = f.wire.query([url], {kinds:[1],limit:1}); void pending.then(() => { completed = true; });
 try {
  await settle(); f.socket.open(); await settle(); const old = req(f.socket);
  f.socket.frame(['EVENT', old, event]); f.socket.frame(['AUTH', 'query-replacement']); await settle();
  const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')![1] as {id:string};
  f.socket.frame(['OK', auth.id, true]); await settle();
  const next = f.socket.sent.filter(frame => frame[0] === 'REQ').at(-1)![1];
  assert.notEqual(old, next);
  f.socket.frame(['EOSE', old]); f.socket.frame(['EVENT', old, event]); await settle();
  assert.equal(completed, false, 'retired physical ID cannot complete the new query');
  f.socket.frame(['EVENT', next, event]); f.socket.frame(['EOSE', next]);
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), [JSON.parse(JSON.stringify(event))], 'only the completed replacement page contributes');
 } finally { f.wire.close(); }
});

test('one logical publication performs at most one AUTH retry without renewing its deadline', async () => {
 const identity = localNip17Identity(), f = fixture({}, template => identity.sign(template));
 const event = await identity.sign({kind:1,created_at:1,tags:[],content:'bounded auth retry'});
 const rejected = assert.rejects(f.wire.publish([url], event), (error:unknown) => error instanceof AggregateError && error.errors[0].code === 'RELAY_AUTH_REQUIRED');
 try {
  f.socket.open(); await settle();
  for (const challenge of ['first', 'second']) {
   f.socket.frame(['AUTH', challenge]); await settle();
   const auth = f.socket.sent.filter(frame => frame[0] === 'AUTH').at(-1)![1] as {id:string};
   f.socket.frame(['OK', auth.id, true]); await settle();
  }
  await rejected; assert.equal(f.socket.sent.filter(frame => frame[0] === 'EVENT').length, 2);
 } finally { f.wire.close(); }
});

test('non-string CLOSED reasons cannot throw into the library raw-frame and private-URL logger', async ctx => {
 const warning = ctx.mock.method(console, 'warn', () => {}), f = fixture();
 const exact = url + '/private?token=synthetic-private-token';
 const pending = assert.rejects(f.wire.query([exact], {}), (error:unknown) => {
  assert.ok(error instanceof RelayError); assert.equal(error.code, 'RELAY_SUBSCRIPTION_REJECTED');
  assert.ok(!JSON.stringify(error).includes('synthetic-private')); return true;
 });
 try {
  await settle(); f.socket.open(); await settle();
  f.socket.frame(['CLOSED', req(f.socket), {text:'synthetic-private-content'}]); await pending;
  assert.equal(warning.mock.callCount(), 0);
 } finally { f.wire.close(); }
});


test('non-EVENT malformed and arbitrary JSON cannot reach the raw dependency logger', async ctx => {
 const warning = ctx.mock.method(console, 'warn', () => {}), f = fixture();
 const pending = f.wire.query([url + '/private?token=synthetic-query-token'], {});
 try {
  await settle(); f.socket.open(); await settle();
  for (const text of ['null','synthetic-private-invalid-json','{"arbitrary":"synthetic-private-content"}','["EOSE",']) f.socket.raw(text);
  f.socket.frame(['NOTICE', 'synthetic-private-content']);
  f.socket.frame(['EOSE', req(f.socket)]); assert.deepEqual(await pending, []);
  assert.equal(warning.mock.callCount(), 0); assert.equal(f.socket.readyState, 1);
 } finally { f.wire.close(); }
});


test('a second explicit auth-required publication rejection is terminal after one AUTH retry', async () => {
 const identity = localNip17Identity(), f = fixture({}, template => identity.sign(template));
 const event = await identity.sign({kind:1,created_at:1,tags:[],content:'one explicit auth retry'});
 const rejected = assert.rejects(f.wire.publish([url],event), (error:unknown) => error instanceof AggregateError && error.errors[0].code === 'RELAY_AUTH_REQUIRED');
 try {
  f.socket.open(); await settle(); f.socket.frame(['OK',event.id,false,'auth-required: fixture']); await settle();
  f.socket.frame(['AUTH','one retry']); await settle(); const auth = f.socket.sent.find(frame => frame[0] === 'AUTH')![1] as {id:string};
  f.socket.frame(['OK',auth.id,true]); await settle();
  assert.equal(f.socket.sent.filter(frame => frame[0] === 'EVENT').length,2);
  f.socket.frame(['OK',event.id,false,'auth-required: still restricted']); await rejected;
  assert.equal(f.socket.sent.filter(frame => frame[0] === 'AUTH').length,1);
 } finally { f.wire.close(); }
});


test('malformed EVENT syntax, shapes and framing never expose synthetic URL tokens or content', async ctx => {
 const warning = ctx.mock.method(console,'warn',()=>{}), f = fixture();
 const pending = f.wire.query([url+'/private?token=synthetic-private-token'],{}), rejected = assert.rejects(pending,timeout('RELAY_HISTORY_INCOMPLETE'));
 try {
  await settle(); f.socket.open(); await settle(); const id = req(f.socket);
  f.socket.raw('["EVENT",'+JSON.stringify(id)+',{"content":synthetic-private-invalid-json}]');
  f.socket.raw('["EVENT",'+JSON.stringify(id)+',{"content":"synthetic-private-truncated"');
  f.socket.frame(['EVENT',id,{tags:null,content:'synthetic-private-content'}]);
  f.socket.frame(['EVENT','untrusted-id-with-escapes',null]);
  f.socket.frame(['EOSE',id]); await rejected;
  assert.equal(warning.mock.callCount(),0);
 } finally { f.wire.close(); }
});

test('valid EVENT JSON with unusual whitespace is framed safely for the library without changing its event',async()=>{
 const f=fixture(),identity=localNip17Identity(),event=await identity.sign({kind:1,created_at:1,tags:[],content:'disposable formatting'});
 const pending=f.wire.query([url],{kinds:[1]});
 try{await settle();f.socket.open();await settle();const id=req(f.socket);f.socket.raw(' '.repeat(100)+'[  "EVENT", '+JSON.stringify(id)+', '+JSON.stringify(event)+' ]');f.socket.frame(['EOSE',id]);const result=await pending;assert.equal(result.length,1);assert.equal(result[0].id,event.id);}finally{f.wire.close();}
});
