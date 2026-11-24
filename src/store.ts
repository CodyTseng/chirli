import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Event } from "nostr-tools";
import { replyTarget, type Rumor } from "./protocol.js";
import type {
  StorageAdapter,
  StoragePayload,
  MessageState,
  MessageQuery,
  StoredMessage,
} from "./storage.js";
import { StorageEncryptionError } from "./errors.js";
import type { MessageStorage } from "./message-storage.js";
import { sqliteMessageStorage } from "./message-storage-sqlite.js";
import { SQLiteStorage } from "./storage-sqlite.js";

export interface Message {
  id: string;
  sender: string;
  conversation: string;
  text: string;
  timestamp: number;
  source: "live" | "history";
  direction: "incoming" | "outgoing";
  rumor: Rumor;
  relay?: string;
  /** ID of the kind-14 parent referenced in the encrypted message. */
  replyTo?: string;
}

export interface HistoryPage {
  messages: Message[];
  nextCursor?: string;
  coverage: "local-only";
  complete: false;
}

export interface MessageListOptions {
  state?: MessageState;
  limit?: number;
  cursor?: string;
}

export interface MessageRecord {
  message: Message;
  state: MessageState;
}

export interface MessageList {
  entries: MessageRecord[];
  nextCursor?: string;
}

export class Store {
  private adapter: StorageAdapter;
  private ownsStorage: boolean;
  private transactionDepth = 0;
  private flushingMessages = false;
  private closeMessages?: () => void;

  constructor(
    storage: string | StorageAdapter,
    private key: Uint8Array | undefined,
    readonly account: string,
    private messageStorage?: MessageStorage,
  ) {
    if (key !== undefined && key.length !== 32) {
      throw new Error("storageKey must contain 32 bytes");
    }
    if (
      typeof storage !== "string" &&
      typeof storage.claimInput !== "function"
    ) {
      throw new TypeError(
        "StorageAdapter.claimInput must atomically claim canonical input IDs",
      );
    }
    this.ownsStorage = typeof storage === "string";
    this.adapter =
      typeof storage === "string" ? new SQLiteStorage(storage) : storage;
    if (!this.messageStorage && typeof storage === "string") {
      try {
        const messages = sqliteMessageStorage(storage);
        this.messageStorage = messages;
        this.closeMessages = () => messages.close();
      } catch (error) {
        this.adapter.close();
        throw error;
      }
    }
  }

  private encode(value: unknown, aad = this.account): StoragePayload {
    if (!this.key) {
      return ("chirli:plain:v1:" +
        JSON.stringify({
          scope: aad,
          value,
        })) as StoragePayload;
    }
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString(
      "base64",
    ) as StoragePayload;
  }

  private decode<T>(value: string, aad = this.account): T {
    if (value.startsWith("chirli:plain:v1:")) {
      if (this.key) {
        throw new StorageEncryptionError("STORAGE_MODE_MISMATCH");
      }
      const record = JSON.parse(value.slice("chirli:plain:v1:".length));
      if (record.scope !== aad || !Object.hasOwn(record, "value")) {
        throw new Error("Invalid plaintext storage record scope");
      }
      return record.value as T;
    }
    if (!this.key) {
      throw new StorageEncryptionError("STORAGE_KEY_REQUIRED");
    }
    const b = Buffer.from(value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
    );
  }

  private decodeMessage(payload: StoragePayload): Message {
    const message = this.decode<Message>(payload);
    // Existing histories already contain the rumor tags even if they predate Message.replyTo.
    const replyTo = replyTarget(message.rumor);
    if (replyTo !== undefined) message.replyTo = replyTo;
    return message;
  }

  insert(
    m: Message,
    state: MessageState = m.source === "live" && m.direction === "incoming"
      ? "pending"
      : "done",
  ) {
    // SQLite stages cross-store writes with metadata/outbox in the same core transaction.
    // The custom backend remains authoritative once that durable handoff completes.
    if (
      this.messageStorage &&
      this.queryMessages({ id: m.id, limit: 1 }).length
    )
      return false;
    const inserted = this.adapter.insert(this.account, {
      collection: "messages",
      record: {
        id: m.id,
        peer: m.conversation,
        time: m.timestamp,
        payload: this.encode(m),
        state,
      },
    });
    if (!this.transactionDepth) this.recoverMessages();
    return this.messageStorage ? true : inserted;
  }

  ensureDmActivation(pubkey: string, proposedAt: number): number {
    const activatedAt = this.adapter.ensureDmActivation(pubkey, proposedAt);
    if (!Number.isSafeInteger(activatedAt) || activatedAt < 0)
      throw new Error("Invalid stored DM activation time");
    return activatedAt;
  }

  claimInput(id: string): boolean {
    const result: unknown = this.adapter.claimInput(this.account, id);
    if (result === true || result === false) return result;
    void Promise.resolve(result).catch(() => {});
    throw new TypeError(
      "StorageAdapter.claimInput must return a boolean synchronously",
    );
  }

  private queryMessages(query: MessageQuery = {}): StoredMessage[] {
    if (!this.messageStorage)
      return this.adapter.queryMessages(this.account, query);
    const order =
      query.order?.time === "desc"
        ? "newest"
        : query.order?.id === "desc"
          ? "recovery"
          : "oldest";
    const rows = this.messageStorage.query(this.account, {
      id: query.id,
      conversation: query.peer,
      states: query.states,
      order,
      cursor: query.cursor
        ? { timestamp: query.cursor.time, id: query.cursor.id }
        : undefined,
      limit: query.limit,
    });
    this.assertSynchronous(rows, "query");
    return rows.map((row) => ({
      id: row.id,
      peer: row.conversation,
      time: row.timestamp,
      payload: row.payload as StoragePayload,
      state: row.state,
    }));
  }

  state(id: string, state: MessageState) {
    if (!this.messageStorage) {
      this.adapter.updateMessageState(this.account, id, state);
      return;
    }
    const result: unknown = this.messageStorage.updateState(
      this.account,
      id,
      state,
    );
    this.assertSynchronous(result, "updateState");
  }

  pending() {
    this.recoverMessages();
    return this.queryMessages({
      states: ["pending", "processing", "failed"],
      order: { time: "asc", id: "desc" },
    }).map((row) => this.decodeMessage(row.payload));
  }

  messageState(id: string): MessageState | undefined {
    return this.queryMessages({ id, limit: 1 })[0]?.state;
  }

  getMessage(id: string, peer?: string): Message | undefined {
    const [row] = this.queryMessages({ id, peer, limit: 1 });
    return row ? this.decodeMessage(row.payload) : undefined;
  }

  listMessages(options: MessageListOptions = {}): MessageList {
    const limit = options.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Message list limit must be in 1..100");
    }
    if (
      options.state !== undefined &&
      !["pending", "processing", "failed", "done"].includes(options.state)
    ) {
      throw new TypeError("Invalid message state");
    }
    let cursor: [number, string] = [0, ""];
    if (options.cursor !== undefined) {
      try {
        if (
          typeof options.cursor !== "string" ||
          options.cursor.length > 256 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        ) {
          throw new Error();
        }
        const value = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString(),
        );
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !Number.isSafeInteger(value[0]) ||
          value[0] < 0 ||
          typeof value[1] !== "string" ||
          !/^[0-9a-f]{64}$/.test(value[1])
        ) {
          throw new Error();
        }
        cursor = value as [number, string];
      } catch {
        throw new TypeError("Invalid message list cursor");
      }
    }
    this.recoverMessages();
    const rows = this.queryMessages({
      states: options.state ? [options.state] : undefined,
      order: { time: "asc", id: "asc" },
      cursor: { time: cursor[0], id: cursor[1] },
      limit: limit + 1,
    });
    const entries = rows.slice(0, limit).map((row) => ({
        message: this.decodeMessage(row.payload),
        state: row.state,
      })),
      last = rows[Math.min(rows.length, limit) - 1];
    return {
      entries,
      ...(rows.length > limit && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify([last.time, last.id]),
            ).toString("base64url"),
          }
        : {}),
    };
  }

  history(
    peer: string,
    options: {
      limit?: number;
      cursor?: string;
    } = {},
  ): HistoryPage {
    const requestedLimit = options.limit ?? 30;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new TypeError("History limit must be a positive safe integer");
    }
    const limit = Math.min(100, requestedLimit);
    let cursor: [number, string] = [Number.MAX_SAFE_INTEGER, ""];
    if (options.cursor !== undefined) {
      try {
        if (
          typeof options.cursor !== "string" ||
          options.cursor.length > 256 ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        ) {
          throw new Error();
        }
        const decoded: unknown = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString(),
        );
        if (
          !Array.isArray(decoded) ||
          decoded.length !== 2 ||
          !Number.isSafeInteger(decoded[0]) ||
          decoded[0] < 0 ||
          typeof decoded[1] !== "string" ||
          !/^[0-9a-f]{64}$/.test(decoded[1])
        ) {
          throw new Error();
        }
        cursor = decoded as [number, string];
      } catch {
        throw new TypeError("Invalid history cursor");
      }
    }
    this.recoverMessages();
    const rows = this.queryMessages({
      peer,
      order: { time: "desc", id: "asc" },
      cursor: { time: cursor[0], id: cursor[1] },
      limit: limit + 1,
    });
    const messages = rows
        .slice(0, limit)
        .map((r) => this.decodeMessage(r.payload)),
      last = messages.at(-1);
    return {
      messages,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.timestamp, last.id])).toString(
              "base64url",
            )
          : undefined,
      coverage: "local-only",
      complete: false,
    };
  }

  putOutbox(
    id: string,
    events: {
      event: Event;
      relays: string[];
    }[],
  ) {
    const inserted = this.adapter.insert(this.account, {
      collection: "outbox",
      record: { id, payload: this.encode(events), state: "pending" },
    });
    if (!inserted) throw new Error("Duplicate outbox ID");
  }

  outbox() {
    return this.adapter
      .queryOutbox(this.account, { state: "pending" })
      .map((r) => ({
        id: r.id,
        events: this.decode<
          {
            event: Event;
            relays: string[];
          }[]
        >(r.payload),
      }));
  }

  ack(id: string) {
    this.adapter.updateOutboxState(this.account, id, "relay-accepted");
  }

  evidence(peer: string) {
    return this.adapter.getEvidence(this.account, peer);
  }

  observe(peer: string, key: string, time: number, id: string) {
    const old = this.evidence(peer);
    if (!old || time > old.time || (time === old.time && id < old.id)) {
      this.adapter.setEvidence(this.account, peer, {
        key,
        time,
        id,
      });
    }
  }

  declaration(peer: string): Event | undefined {
    const row = this.adapter.getDeclaration(this.account, peer);
    return row ? this.decode<Event>(row.payload) : undefined;
  }

  rememberDeclaration(event: Event) {
    const old = this.adapter.getDeclaration(this.account, event.pubkey);
    if (
      !old ||
      event.created_at > old.time ||
      (event.created_at === old.time && event.id < old.id)
    ) {
      this.adapter.setDeclaration(this.account, event.pubkey, {
        time: event.created_at,
        id: event.id,
        payload: this.encode(event),
      });
    }
  }

  markSplitPeer(peer: string) {
    this.adapter.markSplitPeer(this.account, peer);
  }

  isSplitPeer(peer: string) {
    return this.adapter.isSplitPeer(this.account, peer);
  }

  session<T>(peer: string): T | undefined {
    const row = this.adapter.getSession(this.account, peer);
    return row ? this.decode<T>(row) : undefined;
  }

  saveSession(peer: string, value: unknown) {
    this.adapter.setSession(this.account, peer, this.encode(value));
  }

  checkpoint(relay: string) {
    return this.adapter.getCheckpoint(this.account, relay);
  }

  saveCheckpoint(relay: string, through: number) {
    this.adapter.setCheckpoint(
      this.account,
      relay,
      Math.max(this.checkpoint(relay) ?? 0, through),
    );
  }

  transaction(run: () => void) {
    this.transactionDepth++;
    try {
      this.adapter.transaction(run);
    } finally {
      this.transactionDepth--;
    }
    this.recoverMessages();
  }

  keyring<T>(identity: string): T | undefined {
    const row = this.adapter.getKeyring(identity);
    return row ? this.decode<T>(row, `chirli:keyring:${identity}`) : undefined;
  }

  saveKeyring(identity: string, value: unknown) {
    this.adapter.setKeyring(
      identity,
      this.encode(value, `chirli:keyring:${identity}`),
    );
  }

  metadata<T>(name: string): T | undefined {
    return this.session<T>(`@chirli:${name}`);
  }

  saveMetadata(name: string, value: unknown) {
    this.saveSession(`@chirli:${name}`, value);
  }

  private assertSynchronous(result: unknown, method: string) {
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new TypeError(`MessageStorage.${method} must be synchronous`);
    }
  }

  /** Replay committed handoffs; never overwrite an existing backend record or its state. */
  recoverMessages() {
    if (!this.messageStorage || this.transactionDepth || this.flushingMessages)
      return;
    if (!(this.adapter instanceof SQLiteStorage))
      throw new Error("Message storage requires the internal SQLite database");
    this.flushingMessages = true;
    try {
      for (;;) {
        const rows = this.adapter.queryMessages(this.account, { limit: 100 });
        if (!rows.length) break;
        for (const row of rows) {
          const inserted: unknown = this.messageStorage.insert(this.account, {
            id: row.id,
            conversation: row.peer,
            timestamp: row.time,
            payload: row.payload,
            state: row.state,
          });
          this.assertSynchronous(inserted, "insert");
          if (typeof inserted !== "boolean")
            throw new TypeError("MessageStorage.insert must return a boolean");
          this.adapter.discardStagedMessage(this.account, row.id);
        }
      }
    } finally {
      this.flushingMessages = false;
    }
  }

  close() {
    try {
      this.closeMessages?.();
    } finally {
      if (this.ownsStorage) this.adapter.close();
    }
  }
}
