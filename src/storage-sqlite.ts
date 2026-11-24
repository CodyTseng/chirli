import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync } from "node:fs";
import type {
  StorageAdapter,
  StoragePayload,
  StoredMessage,
  StoredOutbox,
  MessageState,
  KeyEvidence,
  StoredDeclaration,
  MessageQuery,
  OutboxQuery,
  OutboxState,
  StorageRecord,
} from "./storage.js";

/** Indexed relational storage. Query planning stays in the database. */
export class SQLiteStorage implements StorageAdapter {
  private db: DatabaseSync;

  constructor(path = "psstpsst.sqlite") {
    if (path !== ":memory:") closeSync(openSync(path, "a", 0o600));
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages(account TEXT,id TEXT,peer TEXT,time INTEGER,payload TEXT,state TEXT,PRIMARY KEY(account,id));
      CREATE INDEX IF NOT EXISTS history ON messages(account,peer,time DESC,id ASC);
      CREATE INDEX IF NOT EXISTS message_list ON messages(account,time ASC,id ASC);
      CREATE INDEX IF NOT EXISTS message_state ON messages(account,state,time ASC,id ASC);
      CREATE INDEX IF NOT EXISTS message_unfinished ON messages(account,time ASC,id DESC) WHERE state IN ('pending','processing','failed');
      CREATE TABLE IF NOT EXISTS dm_activations(pubkey TEXT PRIMARY KEY, activated_at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS input_claims(account TEXT,id TEXT,PRIMARY KEY(account,id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS outbox(account TEXT,id TEXT,payload TEXT,state TEXT,PRIMARY KEY(account,id));
      CREATE INDEX IF NOT EXISTS outbox_state ON outbox(account,state,id);
      CREATE TABLE IF NOT EXISTS evidence(account TEXT,peer TEXT,key TEXT,time INTEGER,id TEXT,PRIMARY KEY(account,peer));
      CREATE TABLE IF NOT EXISTS sessions(account TEXT,peer TEXT,payload TEXT,PRIMARY KEY(account,peer));
      CREATE TABLE IF NOT EXISTS relay_checkpoints(account TEXT,relay TEXT,through INTEGER,PRIMARY KEY(account,relay));
      CREATE TABLE IF NOT EXISTS encryption_keyrings(identity TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE IF NOT EXISTS peer_declarations(account TEXT,peer TEXT,time INTEGER,id TEXT,payload TEXT,split_seen INTEGER DEFAULT 0,PRIMARY KEY(account,peer));`);
  }

  /** Remove a committed handoff only after the message backend has durably accepted it. */
  discardStagedMessage(account: string, id: string): void {
    this.db
      .prepare("DELETE FROM messages WHERE account=? AND id=?")
      .run(account, id);
  }

  insert(account: string, value: StorageRecord): boolean {
    const row = value.record;
    if (value.collection === "messages") {
      const message = value.record;
      return (
        this.db
          .prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?)")
          .run(
            account,
            message.id,
            message.peer,
            message.time,
            message.payload,
            message.state,
          ).changes === 1
      );
    }
    if (value.collection !== "outbox")
      throw new TypeError("Invalid storage collection");
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?)")
        .run(account, row.id, row.payload, row.state).changes === 1
    );
  }

  ensureDmActivation(pubkey: string, proposedAt: number): number {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO dm_activations(pubkey, activated_at) VALUES(?,?)",
      )
      .run(pubkey, proposedAt);
    return (
      this.db
        .prepare("SELECT activated_at FROM dm_activations WHERE pubkey=?")
        .get(pubkey) as { activated_at: number }
    ).activated_at;
  }

  claimInput(account: string, id: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO input_claims(account,id) VALUES(?,?)")
        .run(account, id).changes === 1
    );
  }

  queryMessages(account: string, query: MessageQuery = {}): StoredMessage[] {
    const timeOrder = query.order?.time ?? "asc";
    const idOrder = query.order?.id ?? "asc";
    if (
      !["asc", "desc"].includes(timeOrder) ||
      !["asc", "desc"].includes(idOrder)
    ) {
      throw new TypeError("Invalid message query ordering");
    }
    const where = ["account=?"];
    const parameters: (string | number)[] = [account];
    if (query.id !== undefined) {
      where.push("id=?");
      parameters.push(query.id);
    }
    if (query.peer !== undefined) {
      where.push("peer=?");
      parameters.push(query.peer);
    }
    if (query.states) {
      if (!query.states.length) return [];
      const states = [...new Set(query.states)];
      if (
        !states.every((state) =>
          ["pending", "processing", "failed", "done"].includes(state),
        )
      )
        throw new TypeError("Invalid message query state");
      if (states.length === 3 && !states.includes("done")) {
        // Match the unfinished-work partial index without scanning completed history.
        where.push("state IN ('pending','processing','failed')");
      } else {
        where.push(`state IN (${states.map(() => "?").join(",")})`);
        parameters.push(...states);
      }
    }
    if (query.cursor) {
      const timeComparison = timeOrder === "asc" ? ">" : "<";
      const idComparison = idOrder === "asc" ? ">" : "<";
      // The outer range condition lets SQLite seek to the cursor in the ordering index.
      where.push(
        `time ${timeComparison}= ? AND (time ${timeComparison} ? OR (time=? AND id ${idComparison} ?))`,
      );
      parameters.push(
        query.cursor.time,
        query.cursor.time,
        query.cursor.time,
        query.cursor.id,
      );
    }
    let sql = `SELECT id,peer,time,payload,state FROM messages WHERE ${where.join(" AND ")} ORDER BY time ${timeOrder},id ${idOrder}`;
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 0)
        throw new TypeError("Invalid query limit");
      sql += " LIMIT ?";
      parameters.push(query.limit);
    }
    return this.db
      .prepare(sql)
      .all(...parameters) as unknown as StoredMessage[];
  }

  queryOutbox(account: string, query: OutboxQuery = {}): StoredOutbox[] {
    const where = ["account=?"];
    const parameters: (string | number)[] = [account];
    if (query.id !== undefined) {
      where.push("id=?");
      parameters.push(query.id);
    }
    if (query.state !== undefined) {
      where.push("state=?");
      parameters.push(query.state);
    }
    let sql = `SELECT id,payload,state FROM outbox WHERE ${where.join(" AND ")} ORDER BY id ASC`;
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 0)
        throw new TypeError("Invalid query limit");
      sql += " LIMIT ?";
      parameters.push(query.limit);
    }
    return this.db.prepare(sql).all(...parameters) as unknown as StoredOutbox[];
  }

  updateMessageState(account: string, id: string, state: MessageState): void {
    if (!["pending", "processing", "failed", "done"].includes(state))
      throw new TypeError("Invalid message state");
    this.db
      .prepare("UPDATE messages SET state=? WHERE account=? AND id=?")
      .run(state, account, id);
  }

  updateOutboxState(account: string, id: string, state: OutboxState): void {
    if (!["pending", "relay-accepted"].includes(state))
      throw new TypeError("Invalid outbox state");
    this.db
      .prepare("UPDATE outbox SET state=? WHERE account=? AND id=?")
      .run(state, account, id);
  }

  getEvidence(a: string, p: string) {
    return this.db
      .prepare("SELECT key,time,id FROM evidence WHERE account=? AND peer=?")
      .get(a, p) as KeyEvidence | undefined;
  }
  setEvidence(a: string, p: string, r: KeyEvidence) {
    this.db
      .prepare(
        "INSERT INTO evidence VALUES(?,?,?,?,?) ON CONFLICT(account,peer) DO UPDATE SET key=excluded.key,time=excluded.time,id=excluded.id",
      )
      .run(a, p, r.key, r.time, r.id);
  }
  getDeclaration(a: string, p: string) {
    const row = this.db
      .prepare(
        "SELECT time,id,payload FROM peer_declarations WHERE account=? AND peer=?",
      )
      .get(a, p) as StoredDeclaration | undefined;
    return row?.payload ? row : undefined;
  }
  setDeclaration(a: string, p: string, r: StoredDeclaration) {
    this.db
      .prepare(
        "INSERT INTO peer_declarations(account,peer,time,id,payload) VALUES(?,?,?,?,?) ON CONFLICT(account,peer) DO UPDATE SET time=excluded.time,id=excluded.id,payload=excluded.payload",
      )
      .run(a, p, r.time, r.id, r.payload);
  }
  markSplitPeer(a: string, p: string) {
    this.db
      .prepare(
        "INSERT INTO peer_declarations(account,peer,split_seen) VALUES(?,?,1) ON CONFLICT(account,peer) DO UPDATE SET split_seen=1",
      )
      .run(a, p);
  }
  isSplitPeer(a: string, p: string) {
    return (
      (
        this.db
          .prepare(
            "SELECT split_seen FROM peer_declarations WHERE account=? AND peer=?",
          )
          .get(a, p) as { split_seen: number } | undefined
      )?.split_seen === 1
    );
  }
  getSession(a: string, p: string) {
    return (
      this.db
        .prepare("SELECT payload FROM sessions WHERE account=? AND peer=?")
        .get(a, p) as { payload: StoragePayload } | undefined
    )?.payload;
  }
  setSession(a: string, p: string, payload: StoragePayload) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(account,peer) DO UPDATE SET payload=excluded.payload",
      )
      .run(a, p, payload);
  }
  getCheckpoint(a: string, r: string) {
    return (
      this.db
        .prepare(
          "SELECT through FROM relay_checkpoints WHERE account=? AND relay=?",
        )
        .get(a, r) as { through: number } | undefined
    )?.through;
  }
  setCheckpoint(a: string, r: string, t: number) {
    this.db
      .prepare(
        "INSERT INTO relay_checkpoints VALUES(?,?,?) ON CONFLICT(account,relay) DO UPDATE SET through=excluded.through",
      )
      .run(a, r, t);
  }
  getKeyring(i: string) {
    return (
      this.db
        .prepare("SELECT payload FROM encryption_keyrings WHERE identity=?")
        .get(i) as { payload: StoragePayload } | undefined
    )?.payload;
  }
  setKeyring(i: string, p: StoragePayload) {
    this.db
      .prepare(
        "INSERT INTO encryption_keyrings VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload",
      )
      .run(i, p);
  }
  transaction(run: () => void) {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
