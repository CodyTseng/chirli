/** Example custom adapter for small local deployments; full-file snapshots, one writer only. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageAdapter, StoragePayload, StoredMessage, StoredOutbox, MessageState, KeyEvidence, StoredDeclaration, MessageQuery, OutboxQuery, OutboxState, StorageRecord } from '../src/storage.js';
interface Data {
  schema: 1;
  messages: Record<string, { account: string; row: StoredMessage }>;
  outbox: Record<string, { account: string; row: StoredOutbox }>;
  evidence: Record<string, KeyEvidence>; declarations: Record<string, StoredDeclaration>;
  split: Record<string, boolean>; sessions: Record<string, StoragePayload>;
  checkpoints: Record<string, number>; keyrings: Record<string, StoragePayload>;
}
const fresh = (): Data => ({ schema: 1, messages: {}, outbox: {}, evidence: {}, declarations: {}, split: {}, sessions: {}, checkpoints: {}, keyrings: {} });
const key = (...values: string[]) => JSON.stringify(values);
const copy = <T>(value: T): T => structuredClone(value);
export class JsonStorage implements StorageAdapter {
  private data: Data; private depth = 0; private closed = false;
  constructor(private path: string) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fresh();
    if (this.data.schema !== 1) throw new Error('Unsupported custom storage schema; migrate explicitly');
    for (const name of ['messages', 'outbox', 'evidence', 'declarations', 'split', 'sessions', 'checkpoints', 'keyrings'] as const) if (!this.data[name] || typeof this.data[name] !== 'object' || Array.isArray(this.data[name])) throw new Error('Invalid custom storage; refusing reset');
  }
  private check() { if (this.closed) throw new Error('Custom storage is closed; reopen after an uncertain commit'); }
  private persist() {
    const temporary = `${this.path}.${randomUUID()}.tmp`; let renamed = false;
    try {
      const file = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(file, JSON.stringify(this.data)); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, this.path); renamed = true;
      const directory = openSync(dirname(this.path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) { if (renamed) this.closed = true; throw error; }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private write<T>(run: () => T): T {
    this.check(); const previous = this.data; this.data = copy(previous);
    try { const result = run(); if (!this.depth) this.persist(); return result; } catch (error) { this.data = previous; throw error; }
  }
  insert(account: string, value: StorageRecord): boolean {
    return this.write(() => {
      const collection = this.data[value.collection];
      const id = key(account, value.record.id);
      if (collection[id]) return false;
      if (value.collection === 'messages') this.data.messages[id] = { account, row: copy(value.record) };
      else this.data.outbox[id] = { account, row: copy(value.record) };
      return true;
    });
  }

  queryMessages(account: string, query: MessageQuery = {}): StoredMessage[] {
    this.check();
    const timeDirection = query.order?.time === 'desc' ? -1 : 1;
    const idDirection = query.order?.id === 'desc' ? -1 : 1;
    const compare = (row: Pick<StoredMessage, 'time' | 'id'>, other: Pick<StoredMessage, 'time' | 'id'>) =>
      timeDirection * (row.time - other.time) || idDirection * row.id.localeCompare(other.id);
    const rows = Object.values(this.data.messages)
      .filter(item => item.account === account)
      .map(item => item.row)
      .filter(row => (query.id === undefined || row.id === query.id) &&
        (query.peer === undefined || row.peer === query.peer) &&
        (!query.states || query.states.includes(row.state)) &&
        (!query.cursor || compare(row, query.cursor) > 0))
      .sort(compare);
    return copy(query.limit === undefined ? rows : rows.slice(0, query.limit));
  }

  queryOutbox(account: string, query: OutboxQuery = {}): StoredOutbox[] {
    this.check();
    const rows = Object.values(this.data.outbox)
      .filter(item => item.account === account)
      .map(item => item.row)
      .filter(row => (query.id === undefined || row.id === query.id) &&
        (query.state === undefined || row.state === query.state))
      .sort((a, b) => a.id.localeCompare(b.id));
    return copy(query.limit === undefined ? rows : rows.slice(0, query.limit));
  }

  updateMessageState(account: string, id: string, state: MessageState): void {
    if (!['pending', 'processing', 'failed', 'done'].includes(state)) throw new TypeError('Invalid message state');
    this.write(() => {
      const item = this.data.messages[key(account, id)];
      if (item) item.row.state = state;
    });
  }

  updateOutboxState(account: string, id: string, state: OutboxState): void {
    if (!['pending', 'relay-accepted'].includes(state)) throw new TypeError('Invalid outbox state');
    this.write(() => {
      const item = this.data.outbox[key(account, id)];
      if (item) item.row.state = state;
    });
  }

  getEvidence(a: string, p: string) { this.check(); return copy(this.data.evidence[key(a, p)]); }
  setEvidence(a: string, p: string, row: KeyEvidence) { this.write(() => { this.data.evidence[key(a, p)] = copy(row); }); }
  getDeclaration(a: string, p: string) { this.check(); return copy(this.data.declarations[key(a, p)]); }
  setDeclaration(a: string, p: string, row: StoredDeclaration) { this.write(() => { this.data.declarations[key(a, p)] = copy(row); }); }
  markSplitPeer(a: string, p: string) { this.write(() => { this.data.split[key(a, p)] = true; }); }
  isSplitPeer(a: string, p: string) { this.check(); return this.data.split[key(a, p)] === true; }
  getSession(a: string, p: string) { this.check(); return this.data.sessions[key(a, p)]; }
  setSession(a: string, p: string, payload: StoragePayload) { this.write(() => { this.data.sessions[key(a, p)] = payload; }); }
  getCheckpoint(a: string, r: string) { this.check(); return this.data.checkpoints[key(a, r)]; }
  setCheckpoint(a: string, r: string, t: number) { this.write(() => { this.data.checkpoints[key(a, r)] = t; }); }
  getKeyring(i: string) { this.check(); return this.data.keyrings[key(i)]; }
  setKeyring(i: string, payload: StoragePayload) { this.write(() => { this.data.keyrings[key(i)] = payload; }); }
  transaction(run: () => void) {
    this.check(); if (this.depth) throw new Error('Nested storage transactions are unsupported');
    const previous = this.data; this.data = copy(previous); this.depth++;
    try { run(); this.depth--; this.persist(); } catch (error) { this.depth = 0; this.data = previous; throw error; }
  }
  close() { this.closed = true; }
}
