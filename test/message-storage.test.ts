import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '../src/client.js';
import * as api from '../src/index.js';
import { Store, type Message } from '../src/store.js';
import { SQLiteStorage } from '../src/storage-sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import type { MessageStorage, MessageStorageEntry, MessageStorageQuery } from '../src/message-storage.js';
import { localNip17Identity, rumor, wrap, standardEnvelope } from '../src/protocol.js';
import { MemoryRelay } from '../examples/_support.js';
import { JsonMessageStorage } from '../examples/_json-storage.js';

/** Exercise the public contract against native indexed SQL in addition to the file example. */
class SQLMessages implements MessageStorage {
  readonly database = api.sqliteMessageStorage(':memory:');
  failing = false;
  insert(account: string, row: MessageStorageEntry) {
    if (this.failing) throw new Error('message storage unavailable');
    return this.database.insert(account, row);
  }
  query(account: string, options: MessageStorageQuery = {}) {
    return this.database.query(account, options);
  }
  updateState(account: string, id: string, state: api.MessageState) {
    if (this.failing) throw new Error('message storage unavailable');
    this.database.updateState(account, id, state);
  }
}

const message = (id: number, timestamp = id): Message => ({
  id: id.toString(16).padStart(64, '0'), timestamp, conversation: 'peer', sender: 'peer',
  text: `private message ${id}`, direction: 'incoming', source: 'live', rumor: {} as Message['rumor'],
});

test('public message storage includes processing state while core storage stays private', async () => {
  assert.equal('SQLiteStorage' in api, false);
  const signer = api.nsecSigner(api.generateSecretKey());
  const storage = new SQLMessages();
  try {
    await assert.rejects(Client.create({ signer, storage: {} } as never), /messageStorage/);
    const client = await Client.create({ signer, database: ':memory:', messageStorage: storage });
    try { assert.equal('store' in client, false); } finally { await client.close(); }
  } finally { storage.database.close(); await signer.close(); }
});

for (const Backend of [SQLMessages, JsonMessageStorage]) {
  test(`${Backend.name}: message state, deduplication, recovery, queries and history share one record`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chirli-message-state-'));
    const storage = Backend === SQLMessages ? new SQLMessages() : new JsonMessageStorage(join(directory, 'messages.json'));
    const store = new Store(':memory:', api.generateSecretKey(), 'account', storage);
    const other = new Store(':memory:', undefined, 'other', storage);
    try {
      for (let i = 1; i <= 4; i++) assert.equal(store.insert(message(i, 10)), true);
      store.state(message(1).id, 'done');
      store.state(message(2).id, 'failed');
      store.state(message(3).id, 'processing');
      assert.equal(store.insert({ ...message(1), text: 'duplicate must not replace' }), false);
      assert.equal(store.messageState(message(1).id), 'done');
      assert.equal(store.getMessage(message(1).id, 'peer')?.text, 'private message 1');
      assert.equal(store.getMessage(message(1).id, 'other-peer'), undefined);
      assert.equal(store.listMessages({ state: 'failed' }).entries[0].message.id, message(2).id);
      assert.deepEqual(store.pending().map(row => row.id), [message(4).id, message(3).id, message(2).id]);
      assert.equal(storage.query('account', { states: ['done'] })[0].state, 'done');
      assert.deepEqual(storage.query('account', { states: [] }), []);
      assert.deepEqual(storage.query('account', { limit: 0 }), []);
      const rows = storage.query('account', { id: message(1).id });
      rows[0].state = 'failed';
      assert.equal(store.messageState(message(1).id), 'done');
      assert.ok(!rows[0].payload.includes('private message'));
      const internal = Reflect.get(store, 'adapter') as SQLiteStorage;
      assert.deepEqual(internal.queryMessages('account'), [], 'core holds no second copy after handoff');
      other.insert({ ...message(1), text: 'other account' });
      assert.equal(other.messageState(message(1).id), 'pending');
      const page = store.history('peer', { limit: 2 });
      assert.equal(page.messages[0].text, 'private message 1');
      assert.deepEqual(store.history('peer', { limit: 2, cursor: page.nextCursor }).messages.map(row => row.id), [message(3).id, message(4).id]);
      assert.equal(store.history('absent').messages.length, 0);
      const list = store.listMessages({ limit: 2 });
      assert.deepEqual(store.listMessages({ limit: 2, cursor: list.nextCursor }).entries.map(row => row.message.id), [message(3).id, message(4).id]);
    } finally {
      store.close(); other.close();
      if (storage instanceof SQLMessages) storage.database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('committed handoffs survive failed insertion and restart without exposing partial core transactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chirli-message-handoff-'));
  const database = join(directory, 'core.sqlite'), storage = new SQLMessages(), key = api.generateSecretKey();
  let store = new Store(database, key, 'account', storage);
  try {
    assert.throws(() => store.transaction(() => { store.insert(message(1)); throw new Error('rollback'); }), /rollback/);
    assert.deepEqual(storage.query('account'), []);
    storage.failing = true;
    assert.throws(() => store.transaction(() => {
      store.insert(message(2)); store.putOutbox(message(2).id, []);
    }), /unavailable/);
    assert.equal(storage.query('account').length, 0);
    assert.equal(store.outbox().length, 1, 'exact outbox remains durable');
    store.close();
    storage.failing = false;
    store = new Store(database, key, 'account', storage);
    assert.equal(store.pending()[0].id, message(2).id);
    store.state(message(2).id, 'done');
    store.close();
    store = new Store(database, key, 'account', storage);
    assert.equal(store.messageState(message(2).id), 'done');
    assert.deepEqual(store.pending(), []);
    assert.equal(store.insert(message(2)), false);
  } finally { store.close(); storage.database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('replaying an uncertain insert cannot reset an already processed message', () => {
  const storage = new SQLMessages(), store = new Store(':memory:', undefined, 'account', storage);
  const insert = storage.insert.bind(storage);
  storage.insert = (account, row) => { insert(account, row); throw new Error('uncertain insert'); };
  try {
    assert.throws(() => store.insert(message(1)), /uncertain/);
    storage.updateState('account', message(1).id, 'done');
    storage.insert = insert;
    assert.deepEqual(store.pending(), []);
    assert.equal(store.messageState(message(1).id), 'done');
  } finally { store.close(); storage.database.close(); }
});

test('state persistence failure does not let a duplicate reexecute a custom-storage message', async () => {
  const relay = new MemoryRelay(), storage = new SQLMessages(), sender = localNip17Identity();
  const signer = api.nsecSigner(api.generateSecretKey());
  const client = await Client.create({ signer, database: ':memory:', messageStorage: storage,
    transport: relay.transport(), relays: ['ws://state.invalid'], keySync: false, recovery: false });
  let handled = 0;
  const errors: unknown[] = [];
  client.onError(error => { errors.push(error); });
  client.handle(() => { handled++; storage.failing = true; });
  try {
    await client.announce(); await client.start();
    const draft = rumor(sender.pubkey, client.pubkey, 'incoming');
    const event = await wrap(draft, sender, client.pubkey, client.pubkey, standardEnvelope);
    await client.receive(event, 'live'); await client.idle();
    assert.equal(client.getMessageState(draft.id), 'processing');
    assert.equal(handled, 1);
    assert.ok(errors.length > 0);
    storage.failing = false;
    assert.equal(await client.receive(event, 'live'), false); await client.idle();
    await client.stop(); await client.start(); await client.idle();
    assert.equal(handled, 1, 'duplicate or restart must never reexecute a claimed input');
    assert.equal(client.getMessageState(draft.id), 'processing');
    assert.equal(storage.query((Reflect.get(client, 'coreStore') as Store).account, { id: draft.id })[0].state, 'processing');
  } finally { await client.close(); storage.database.close(); await signer.close(); }
});

for (const injected of [false, true]) {
  test(`${injected ? 'injected' : 'default'} sqliteMessageStorage preserves done across database reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chirli-default-messages-'));
    const database = join(directory, 'internal.sqlite'), messagePath = join(directory, 'messages.sqlite');
    const signer = api.nsecSigner(api.generateSecretKey()), sender = localNip17Identity(), relay = new MemoryRelay();
    let messages = injected ? api.sqliteMessageStorage(messagePath) : undefined;
    const open = () => Client.create({ signer, database, messageStorage: messages,
      transport: relay.transport(), relays: ['ws://reopen.invalid'], keySync: false, recovery: false });
    let client = await open(), handled = 0;
    try {
      client.handle(() => { handled++; });
      await client.start();
      const draft = rumor(sender.pubkey, client.pubkey, 'once');
      const event = await wrap(draft, sender, client.pubkey, client.pubkey, standardEnvelope);
      await client.receive(event, 'live'); await client.idle();
      assert.equal(handled, 1);
      await client.close();
      if (messages) {
        assert.doesNotThrow(() => messages!.query('account'));
        messages.close();
        messages = api.sqliteMessageStorage(messagePath);
      }
      client = await open();
      client.handle(() => { handled++; });
      await client.start();
      assert.equal(client.getMessageState(draft.id), 'done');
      assert.equal(await client.receive(event, 'live'), false);
      await client.idle();
      assert.equal(handled, 1);
    } finally {
      await client.close(); messages?.close(); await signer.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('sqliteMessageStorage uses native indexes and bounded queries for history, state and recovery', ctx => {
  const storage = api.sqliteMessageStorage(':memory:');
  try {
    for (let i = 0; i < 5000; i++) storage.insert('account', {
      id: String(i).padStart(8, '0'), conversation: 'peer', timestamp: i,
      payload: 'opaque', state: i % 100 ? 'done' : 'failed',
    });
    const prepare = DatabaseSync.prototype.prepare;
    const plans: string[][] = [];
    ctx.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith('SELECT id,conversation')) {
        const all = statement.all;
        Reflect.set(statement, 'all', (...parameters: unknown[]) => {
          const explain = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`);
          const rows = Reflect.apply(explain.all, explain, parameters) as { detail: string }[];
          plans.push(rows.map(row => row.detail));
          assert.ok(sql.includes('LIMIT ?'));
          return Reflect.apply(all, statement, parameters);
        });
      }
      return statement;
    });
    storage.query('account', { conversation: 'peer', order: 'newest', cursor: { timestamp: 4000, id: '' }, limit: 20 });
    storage.query('account', { order: 'oldest', cursor: { timestamp: 1000, id: '' }, limit: 20 });
    storage.query('account', { states: ['failed'], cursor: { timestamp: 1000, id: '' }, limit: 20 });
    storage.query('account', { states: ['pending', 'processing', 'failed'], order: 'recovery', limit: 20 });
    assert.equal(plans.length, 4);
    for (const plan of plans) {
      assert.ok(plan.some(detail => detail.includes('SEARCH')), plan.join('\n'));
      assert.ok(!plan.some(detail => /SCAN message_records|USE TEMP B-TREE/.test(detail)), plan.join('\n'));
    }
    assert.throws(() => storage.query('account', { order: 'invalid' } as never), /order/);
    assert.throws(() => storage.updateState('account', '1', 'relay-accepted' as never), /state/);
  } finally { storage.close(); }
});
