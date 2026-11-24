import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import type { MessageState } from "./storage.js";
import type {
  MessageStorage,
  MessageStorageEntry,
  MessageStorageQuery,
} from "./message-storage.js";

export interface SQLiteMessageStorage extends MessageStorage {
  close(): void;
}

/** Indexed message persistence. The application owns instances passed into Client. */
export function sqliteMessageStorage(
  path = "chirli-messages.sqlite",
): SQLiteMessageStorage {
  if (path !== ":memory:") closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS message_records(
        account TEXT NOT NULL,id TEXT NOT NULL,conversation TEXT NOT NULL,
        timestamp INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(account,id));
      CREATE INDEX IF NOT EXISTS stored_message_history ON message_records(account,conversation,timestamp DESC,id ASC);
      CREATE INDEX IF NOT EXISTS stored_message_list ON message_records(account,timestamp ASC,id ASC);
      CREATE INDEX IF NOT EXISTS stored_message_state ON message_records(account,state,timestamp ASC,id ASC);
      CREATE INDEX IF NOT EXISTS stored_message_unfinished ON message_records(account,timestamp ASC,id DESC)
        WHERE state IN ('pending','processing','failed');`);
  } catch (error) {
    db.close();
    throw error;
  }

  const validateState = (state: MessageState) => {
    if (!["pending", "processing", "failed", "done"].includes(state))
      throw new TypeError("Invalid message state");
  };

  return {
    insert(account, message) {
      validateState(message.state);
      return (
        db
          .prepare("INSERT OR IGNORE INTO message_records VALUES(?,?,?,?,?,?)")
          .run(
            account,
            message.id,
            message.conversation,
            message.timestamp,
            message.payload,
            message.state,
          ).changes === 1
      );
    },

    updateState(account, id, state) {
      validateState(state);
      db.prepare(
        "UPDATE message_records SET state=? WHERE account=? AND id=?",
      ).run(state, account, id);
    },

    query(account, options: MessageStorageQuery = {}) {
      const order = options.order ?? "oldest";
      if (!["oldest", "newest", "recovery"].includes(order))
        throw new TypeError("Invalid message query order");
      const timeOrder = order === "newest" ? "DESC" : "ASC";
      const idOrder = order === "recovery" ? "DESC" : "ASC";
      const where = ["account=?"];
      const parameters: (string | number)[] = [account];
      if (options.id !== undefined) {
        where.push("id=?");
        parameters.push(options.id);
      }
      if (options.conversation !== undefined) {
        where.push("conversation=?");
        parameters.push(options.conversation);
      }
      if (options.states) {
        if (!options.states.length) return [];
        const states = [...new Set(options.states)];
        for (const state of states) validateState(state);
        if (states.length === 3 && !states.includes("done")) {
          where.push("state IN ('pending','processing','failed')");
        } else {
          where.push(`state IN (${states.map(() => "?").join(",")})`);
          parameters.push(...states);
        }
      }
      if (options.cursor) {
        const timeComparison = order === "newest" ? "<" : ">";
        const idComparison = order === "recovery" ? "<" : ">";
        // This range lets SQLite seek into the ordering index before applying tie-breaking.
        where.push(
          `timestamp ${timeComparison}= ? AND (timestamp ${timeComparison} ? OR (timestamp=? AND id ${idComparison} ?))`,
        );
        parameters.push(
          options.cursor.timestamp,
          options.cursor.timestamp,
          options.cursor.timestamp,
          options.cursor.id,
        );
      }
      let sql = `SELECT id,conversation,timestamp,payload,state FROM message_records WHERE ${where.join(" AND ")} ORDER BY timestamp ${timeOrder},id ${idOrder}`;
      if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 0)
          throw new TypeError("Invalid message query limit");
        sql += " LIMIT ?";
        parameters.push(options.limit);
      }
      return db
        .prepare(sql)
        .all(...parameters) as unknown as MessageStorageEntry[];
    },

    close() {
      db.close();
    },
  };
}
