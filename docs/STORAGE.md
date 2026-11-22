# Message storage

Messages and their processing states belong to `MessageStorage`. The framework's outbox, keys, peer evidence, declarations, sessions and relay checkpoints stay in internal SQLite. Internal persistence accepts only a `database` path; its backend cannot be replaced.

Business conversation state uses `ctx.session`. A Bot can supply a `sessionStore` for that state. Internal sessions used by the framework stay in SQLite. See the [session guide and custom store example](SESSIONS.md#use-a-custom-session-store).

## Configuration

Bot uses `sqliteMessageStorage` by default, with message records in the same database file as the internal tables. `:memory:` keeps both stores in memory. To choose a separate message database:

```ts
import { Bot, sqliteMessageStorage } from 'chirli';

const messages = sqliteMessageStorage('./messages.sqlite');
const bot = new Bot({
  signer,
  database: './internal.sqlite',
  storageKey,
  messageStorage: messages,
});

try {
  await bot.start();
} finally {
  await bot.close();
  messages.close();
}
```

Bot closes its default message backend. Close an injected backend after closing the Bot. Preserve both databases and any storage key across restarts.

## Three-method interface

```ts
interface MessageStorage {
  insert(account: string, message: MessageStorageEntry): boolean;
  query(account: string, options?: MessageStorageQuery): MessageStorageEntry[];
  updateState(account: string, id: string, state: MessageState): void;
}
```

Each entry contains `id`, `conversation`, millisecond `timestamp`, opaque `payload`, and `state`. The SDK handles payload encryption and decoding. States are `pending`, `processing`, `failed` and `done`; a historical or outgoing message starts as done because it requires no incoming handler.

- `insert` must atomically insert once by account + ID. Return false on duplicates, preserving the existing payload and state. This is the deduplication boundary.
- `updateState` durably changes only an existing record's state, scoped by account + ID. It must not create a missing message.
- `query` returns detached records. Optional filters are exact `id`, exact `conversation`, and any of `states`; an empty state array matches nothing. `limit` bounds the result, including zero; omission is unbounded for recovery.
- `order` defaults to `oldest` (timestamp ASC, ID ASC). `newest` uses timestamp DESC, ID ASC; `recovery` uses timestamp ASC, ID DESC. The optional `{timestamp, id}` cursor is exclusive in that order.
- Implement filtering, ordering, cursors and limits in the database. Queries for one message, a conversation, one state and unfinished recovery should use indexes.
- All methods are synchronous and durable on return. Promise-returning methods are unsupported.

History, `getMessage`, `listMessages`, `getMessageState`, duplicate detection and unfinished-message recovery all use this same backend. There are no separate processing flags in the internal database after a successful handoff. No transaction, outbox, keyring or metadata interface is required from custom implementations.

## Failures and restart

For cross-store writes, internal SQLite first commits a temporary message handoff with the corresponding peer metadata or exact outgoing outbox bundle. Only then does the SDK insert the message into `MessageStorage`. Successful insertion removes the temporary record. A crash or uncertain insert can repeat insertion, so duplicates must never reset an existing processing state.

A failed insert leaves the handoff durable and blocks handler dispatch. Startup, history and list reads, inbox retry and later writes can retry it. A send may fail after committing its exact outbox bundle. Use `flushOutbox()` to retry that bundle. A new `send()` creates a new message.

Successful handling writes done to the message backend. A state-write failure leaves the durable state retryable and reports an error. External handler effects may run again: application effects still need idempotence. One active Bot/process per account database is supported.

## SQLite and encryption

`sqliteMessageStorage(path)` provides WAL, synchronous FULL, 0600 permissions for new files, atomic unique insertion and indexed native queries. It exposes only the three message operations and `close`.

`storageKey` encrypts payloads with AES-GCM before storage. Without it, payloads use tagged plaintext. Routing metadata and states remain visible. Preserve the original key; missing/wrong keys fail rather than resetting data.

[JsonMessageStorage](../examples/_json-storage.ts) demonstrates the same three operations for small files. It scans an in-memory model; use indexed queries in production. Run `npm run example:storage` to verify custom message history and internal session recovery after restart.

## Public command journal

Verified public input processing, bounded ID deduplication and exact signed reply retries live in a distinct internal account/mode metadata journal; they do not use the replaceable DM MessageStorage. Default public sessions use a separate namespace. Custom SessionStore implementations must preserve public/private and account key separation. The selected storage codec applies to public journal/session values as well. See [public recovery limits](PUBLIC.md#recovery-and-limits).
