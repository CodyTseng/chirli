/** Small-file example only. Production backends should use indexed database queries. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessageStorage, MessageStorageEntry, MessageStorageQuery, MessageState } from 'chirli';

type Row = { account: string; message: MessageStorageEntry };

export class JsonMessageStorage implements MessageStorage {
  private rows: Row[];
  private failed = false;

  constructor(private path: string) {
    this.rows = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    if (!Array.isArray(this.rows)) throw new Error('Invalid message history file');
  }

  insert(account: string, message: MessageStorageEntry): boolean {
    this.check();
    if (this.rows.some(row => row.account === account && row.message.id === message.id)) return false;
    this.persist([...this.rows, { account, message: structuredClone(message) }]);
    return true;
  }

  updateState(account: string, id: string, state: MessageState): void {
    this.check();
    if (!['pending', 'processing', 'failed', 'done'].includes(state)) throw new TypeError('Invalid message state');
    if (!this.rows.some(row => row.account === account && row.message.id === id)) return;
    this.persist(this.rows.map(row => row.account === account && row.message.id === id
      ? { account, message: { ...row.message, state } } : row));
  }

  private check() {
    if (this.failed) throw new Error('Reopen message storage after an uncertain write');
  }

  private persist(next: Row[]) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temporary, this.path);
      renamed = true;
      const directory = openSync(dirname(this.path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.rows = next;
    } catch (error) {
      if (renamed) this.failed = true;
      throw error;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  query(account: string, options: MessageStorageQuery = {}): MessageStorageEntry[] {
    this.check();
    const timeDirection = options.order === 'newest' ? -1 : 1;
    const idDirection = options.order === 'recovery' ? -1 : 1;
    const compare = (a: { timestamp: number; id: string }, b: { timestamp: number; id: string }) =>
      timeDirection * (a.timestamp - b.timestamp) || idDirection * a.id.localeCompare(b.id);
    const rows = this.rows
      .filter(row => row.account === account)
      .map(row => row.message)
      .filter(row => (options.id === undefined || row.id === options.id) &&
        (options.conversation === undefined || row.conversation === options.conversation) &&
        (!options.states || options.states.includes(row.state)) &&
        (!options.cursor || compare(row, options.cursor) > 0))
      .sort(compare);
    return structuredClone(options.limit === undefined ? rows : rows.slice(0, options.limit));
  }
}
