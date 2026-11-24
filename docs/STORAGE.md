# Message storage

Retained private messages and their diagnostic states belong to `MessageStorage`. The first DM activation timestamp, atomic inbound ID claims, outbox, keys, peer evidence, declarations, sessions and relay checkpoints stay in internal SQLite. Internal persistence accepts only a `database` path; its backend cannot be replaced.

Business conversation state uses `ctx.session`. A Bot can supply a `sessionStore` for that state. Internal sessions used by the framework stay in SQLite. See the [session guide and custom store example](SESSIONS.md#use-a-custom-session-store).

## Configuration

Bot uses `sqliteMessageStorage` by default, with message records in the same database file as the internal tables. `:memory:` keeps both stores in memory. To choose a separate message database:

```ts
import { Bot, sqliteMessageStorage } from "chirli";

const messages = sqliteMessageStorage("./messages.sqlite");
const bot = new Bot({
  signer,
  database: "./internal.sqlite",
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

Bot closes its default message backend. Close an injected backend after closing the Bot. Use fresh database paths for this pre-release storage format, including for any separate history database. Earlier files are unsupported; no migration is provided. Leave them in place if you want to keep them. Preserve the new databases and any storage key across restarts.

## Three-method interface

```ts
interface MessageStorage {
  insert(account: string, message: MessageStorageEntry): boolean;
  query(account: string, options?: MessageStorageQuery): MessageStorageEntry[];
  updateState(account: string, id: string, state: MessageState): void;
}
```

Each entry contains `id`, `conversation`, millisecond `timestamp`, opaque `payload`, and `state`. The SDK handles payload encryption and decoding. These are diagnostic fields on conversation records, not a work queue. An admitted live message can be `processing`, `failed` or `done`. Outgoing and self-copy messages need no incoming handler.

- `insert` must atomically insert once by account + ID. Return false on duplicates, preserving the existing payload and state. This deduplicates storage writes; the prior ID claim in internal SQLite separately controls callback eligibility.
- `updateState` durably changes only an existing record's state, scoped by account + ID. It must not create a missing message.
- `query` returns detached records. Optional filters are exact `id`, exact `conversation`, and any of `states`; an empty state array matches nothing. `limit` bounds the result, including zero.
- `order` defaults to `oldest` (timestamp ASC, ID ASC). `newest` uses timestamp DESC, ID ASC; `recovery` uses timestamp ASC, ID DESC. The optional `{timestamp, id}` cursor is exclusive in that order.
- Implement filtering, ordering, cursors and limits in the database. Queries by exact ID, conversation or diagnostic state should use indexes.
- All methods are synchronous and durable on return. Promise-returning methods are unsupported.

History, `getMessage`, `listMessages` and `getMessageState` use this backend. A claimed ID need not have a history entry. An eligible incoming DM, including one recovered from a relay, is saved only when middleware reaches routing. Pre-activation DMs are ignored and short-circuited DMs retain only their ID claim. No inbound claim, outbox, keyring or metadata interface is required from custom implementations.

## Failures and restart

For cross-store writes, internal SQLite first commits a temporary message handoff with the corresponding peer metadata or exact outgoing outbox bundle. Only then does the SDK insert the message into `MessageStorage`. Successful insertion removes the temporary record. A crash or uncertain insert can repeat insertion, so duplicates must never reset an existing diagnostic state. This repairs storage only, not a handler attempt.

A failed insert can leave a durable handoff for storage recovery. Recovering that record later does not call middleware or handlers. A send may fail after committing its exact outbox bundle. Use `flushOutbox()` to retry that bundle. A new `send()` creates a new message.

An error in a handler or state write does not reopen the ID claim. Keep the internal database as well as any injected history backend across restarts. To retry business effects, persist and operate your own jobs. One active Bot/process per account database is supported.

## SQLite and encryption

`sqliteMessageStorage(path)` provides WAL, synchronous FULL, 0600 permissions for new files, atomic unique insertion and indexed native queries. It exposes only the three message operations and `close`.

`storageKey` encrypts payloads with AES-GCM before storage. Without it, payloads use tagged plaintext. Routing metadata and states remain visible. Preserve the original key; missing/wrong keys fail rather than resetting data.

[JsonMessageStorage](../examples/_json-storage.ts) demonstrates the same three operations for small files. It scans an in-memory model; use indexed queries in production. Run `npm run example:storage` to verify custom message history and internal session recovery after restart.

## Public command journal

Public inputs retain canonical ID claims, not a history, incoming body or queued callback payload. Signed outgoing public replies and reactions share a durable public outbox with exact-ID retries. Neither uses the replaceable DM MessageStorage. Default public sessions use a separate namespace. Custom SessionStore implementations must preserve public/private and account key separation. The selected storage codec applies to public outbox and session values. See [public claims and outgoing retries](PUBLIC.md#claims-and-outgoing-retries).
