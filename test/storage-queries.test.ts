import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

import { SQLiteStorage } from '../src/storage-sqlite.js';
import { type StoragePayload } from '../src/storage.js';
import { type StoredMessage } from '../src/storage.js';
import { JsonStorage } from './json-storage.js';

const row = (id: string, time: number, peer: string, state: StoredMessage['state']): StoredMessage =>
  ({ id, time, peer, state, payload: `opaque-${id}` as StoragePayload });

for (const [name, Backend] of [['SQLite', SQLiteStorage], ['JSON example', JsonStorage]] as const) {
  test(`${name}: unified queries preserve filters, mixed-order cursors, deduplication and atomic state changes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chirli-query-'));
    const storage = new Backend(join(directory, 'data'));
    try {
      for (const message of [row('a', 10, 'alice', 'done'), row('b', 20, 'bob', 'failed'),
        row('c', 20, 'alice', 'pending'), row('d', 20, 'alice', 'failed'), row('e', 30, 'alice', 'processing')]) {
        assert.equal(storage.insert('owner', { collection: 'messages', record: message }), true);
      }
      assert.equal(storage.insert('owner', { collection: 'messages', record: row('c', 99, 'changed', 'done') }), false);
      assert.equal(storage.insert('other', { collection: 'messages', record: row('c', 99, 'other', 'failed') }), true);
      assert.equal(storage.queryMessages('owner', { id: 'c' })[0].peer, 'alice');
      assert.deepEqual(storage.queryMessages('owner', { states: [] }), []);
      assert.deepEqual(storage.queryMessages('owner', { limit: 0 }), []);
      assert.deepEqual(storage.queryMessages('owner', { peer: 'alice', order: { time: 'desc', id: 'asc' } }).map(r => r.id), ['e', 'c', 'd', 'a']);
      assert.deepEqual(storage.queryMessages('owner', { peer: 'alice', order: { time: 'desc', id: 'asc' }, cursor: { time: 20, id: 'c' }, limit: 2 }).map(r => r.id), ['d', 'a']);
      assert.deepEqual(storage.queryMessages('owner', { peer: 'alice', order: { time: 'asc', id: 'desc' }, cursor: { time: 20, id: 'd' } }).map(r => r.id), ['c', 'e']);
      assert.deepEqual(storage.queryMessages('owner', { states: ['pending', 'processing', 'failed'], order: { time: 'asc', id: 'desc' } }).map(r => r.id), ['d', 'c', 'b', 'e']);
      assert.deepEqual(storage.queryMessages('owner', { states: ['failed'], cursor: { time: 20, id: 'b' } }).map(r => r.id), ['d']);

      const record = { id: 'send', payload: 'exact ciphertext' as StoragePayload, state: 'pending' as const };
      assert.equal(storage.insert('owner', { collection: 'outbox', record }), true);
      assert.equal(storage.insert('owner', { collection: 'outbox', record }), false);
      storage.updateOutboxState('owner', 'send', 'relay-accepted');
      assert.equal(storage.queryOutbox('owner', { state: 'pending' }).length, 0);
      assert.equal(storage.queryOutbox('owner', { id: 'send' })[0].payload, record.payload);
      assert.equal(storage.queryOutbox('other').length, 0);
      assert.throws(() => storage.transaction(() => {
        storage.updateMessageState('owner', 'c', 'done');
        storage.updateOutboxState('owner', 'send', 'pending');
        throw new Error('rollback');
      }), /rollback/);
      assert.equal(storage.queryMessages('owner', { id: 'c' })[0].state, 'pending');
      assert.equal(storage.queryOutbox('owner', { state: 'relay-accepted' }).length, 1);
      storage.updateMessageState('owner', 'c', 'done');
      assert.equal(storage.queryMessages('other', { id: 'c' })[0].state, 'failed');
      assert.throws(() => storage.updateMessageState('owner', 'c', 'relay-accepted' as never), /message state/);
      assert.throws(() => storage.updateOutboxState('owner', 'send', 'done' as never), /outbox state/);
      assert.equal(storage.queryMessages('owner', { id: 'c' })[0].state, 'done');
      assert.equal(storage.queryOutbox('owner', { id: 'send' })[0].state, 'relay-accepted');
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('SQLite common message/outbox queries use indexed searches and database-side limits', ctx => {
  const storage = new SQLiteStorage(':memory:');
  const db = Reflect.get(storage, 'db') as DatabaseSync;
  try {
    storage.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        storage.insert('owner', { collection: 'messages', record: row(String(i).padStart(8, '0'), i, 'peer', i % 100 ? 'done' : 'failed') });
      }
      storage.insert('owner', { collection: 'outbox', record: { id: 'queued', payload: 'opaque' as StoragePayload, state: 'pending' } });
    });
    db.exec('ANALYZE');
    const prepare = db.prepare.bind(db);
    const observed: { sql: string; plan: string[] }[] = [];
    ctx.mock.method(db, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT id,')) {
        const all = statement.all;
        Reflect.set(statement, 'all', (...parameters: unknown[]) => {
          const explain = prepare(`EXPLAIN QUERY PLAN ${sql}`);
          const plan = Reflect.apply(explain.all, explain, parameters) as { detail: string }[];
          observed.push({ sql, plan: plan.map(item => item.detail) });
          return Reflect.apply(all, statement, parameters);
        });
      }
      return statement;
    });
    assert.equal(storage.queryMessages('owner', { peer: 'peer', order: { time: 'desc', id: 'asc' }, cursor: { time: 4000, id: '' }, limit: 20 }).length, 20);
    storage.queryMessages('owner', { cursor: { time: 3000, id: '' }, limit: 20 });
    storage.queryMessages('owner', { states: ['failed'], cursor: { time: 1000, id: '' }, limit: 10 });
    storage.queryMessages('owner', { states: ['pending', 'processing', 'failed'], order: { time: 'asc', id: 'desc' }, limit: 20 });
    storage.queryOutbox('owner', { state: 'pending', limit: 20 });
    assert.equal(observed.length, 5);
    for (const { sql, plan } of observed) {
      assert.ok(sql.includes('LIMIT ?'), sql);
      assert.ok(plan.some(detail => detail.includes('SEARCH')), plan.join('\n'));
      assert.ok(!plan.some(detail => /SCAN (messages|outbox|m|a)\b|USE TEMP B-TREE/.test(detail)), plan.join('\n'));
    }
    assert.throws(() => storage.queryMessages('owner', { order: { time: 'asc; DROP TABLE messages', id: 'asc' } } as never), /ordering/);
    assert.equal(storage.queryMessages('owner', { id: '00000001' }).length, 1);
  } finally { storage.close(); }
});
