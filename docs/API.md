# Public API

Chirli is an ESM-only Node.js 24+ package. Import from `chirli`; internal source subpaths are not package exports. Start with the [tutorial](TUTORIAL.md) for an application walkthrough.

## Construction

```ts
import { Bot, nsecSigner } from 'chirli';

const signer = nsecSigner(nsecFromYourSecretManager);
const bot = new Bot({
  signer,
  database: './chirli.sqlite',
});
bot.command({ command: 'ping', scopes: ['kind:14'] }, async ctx => { await ctx.reply('pong'); });
await bot.start();
console.log(bot.pubkey);
```

Construct the Bot and register handlers before calling `start()`. `start()` resolves and caches the signer's public key, opens storage, publishes discovery information and starts receiving messages. Read `bot.pubkey` after startup. `bot.mode` reports the selected protocol mode, with `nip17` as the default. The application owns injected resources. Close the Bot before closing its signer, transport or message backend.

## Configuration

| Option | Contract |
| --- | --- |
| `signer` | Required signing and account-key NIP-44 capabilities; see [signers](SIGNERS.md) |
| `database` | SQLite path; default `psstpsst.sqlite`; `:memory:` is ephemeral |
| `messageStorage` | Retained private conversation history and its diagnostic states; defaults to `sqliteMessageStorage` |
| `sessionStore` | Optional backend for conversation state. See the [custom store example](SESSIONS.md#use-a-custom-session-store). |
| `storageKey` | Optional 32-byte local encryption key; omission selects tagged plaintext |
| `transport` | Injected `Transport`; exclusive with `transportOptions` |
| `transportOptions` | Default WebSocket timeouts and query concurrency |
| `relays` | Nonempty shorthand for each omitted relay role |
| `dmRelays` | Inbox/delivery role; nonempty |
| `readRelays` | Metadata discovery role; `[]` is allowed |
| `writeRelays` | Public metadata/command role; nonempty |
| `discoveryRelays` | Extra recipients for public account announcements; `[]` disables this extra fan-out |
| `blossomServers` | Ordered upload servers; defaults to `https://blossom.jumble.social/`; `[]` disables file uploads |
| `blossomDownloadOrigins` | Optional trusted HTTPS origins for downloads served by a separate CDN |
| `mode` | `nip17` default, or explicit `nip4e` split messaging keys |
| `keyRotation` | Omitted/false, or split-mode rotation settings; see [keys](KEYS.md) |
| `nip4eCompatibility` | False suppresses identity-key 10044 publication; dual intake stays enabled |
| `reconnect` | Retry settings or false; enabled by default |
| `recovery` | Bounded history settings or false; enabled by default |
| `historyLimit` | Initial per-relay giftwrap request limit; default 500 |
| `metadataCache` | Peer cache settings or false; see [relays](RELAYS.md) |
| `keySync` | Same-identity split-key sync settings or false; see [keys](KEYS.md) |

Omitted relay roles use exported `DEFAULT_DM_RELAYS`, `DEFAULT_READ_RELAYS`, `DEFAULT_WRITE_RELAYS` and `DEFAULT_DISCOVERY_RELAYS` unless overridden by the `relays` shorthand. The account, mode and storage codec are fixed for a Bot's lifetime. Use a fresh database for this storage format; earlier pre-release databases are not migrated. Preserve credentials, this database and any storage key across restarts.

## Lifecycle

| Method | Behavior |
| --- | --- |
| `announce(options?)` | Explicitly publish account key/relay metadata and synchronize registered commands |
| `start()` | Resolve the signer, publish key/relay metadata, synchronize commands, open inbox and retry pending outgoing deliveries |
| `idle()` | Drain ordered crypto intake and currently queued handlers |
| `requestStop()` | Request shutdown from a handler without awaiting its own drain |
| `stop()` | Cancel subscriptions/timers/recovery and drain current work; Bot stays reusable |
| `close()` | Stop and release internally owned resources; idempotent |
| `syncHistory()` | Scan running subscriptions' bounded recovery windows |
| `flushAnnouncements()` | Retry pending account metadata and dirty/pending command state |
| `flushOutbox()` | Retry persisted message bundles; aggregate failures after attempting the snapshot |

`start()` does not render or return the identity. After it completes, `bot.pubkey` is the bot account’s 64-character lowercase hex public key. Applications can display it as text or derive a link or QR payload:

```ts
import { npubEncode } from 'nostr-tools/nip19';

await bot.start();
const uri = `nostr:${npubEncode(bot.pubkey)}`;
```

Concurrent start calls share readiness/failure; a start during stop waits for teardown. Startup requires one ready DM replica, while command reconciliation requires every write relay. Other DM replicas can continue recovering. History scans may report incomplete coverage without failing startup. Start does not await every business handler.

`idle()` is not a remote synchronization or delivery barrier. `idle()`, `stop()` and `close()` reject inside message handlers because they would wait on themselves. Use `requestStop()` there, then drain outside the handler. Once stopping begins, new intake is ignored and `bot.receive()` returns `false` without consuming the ID. Work already queued for processing can finish; inputs still being decrypted are not admitted after stop.

Await application-owned sends and stop/await application timers before closing Bot. SDK shutdown drains its own work; it cannot cancel arbitrary application effects. One active Bot/process per account database is supported.

## Event processing flow

1. **Verify.** For a DM, unwrap the envelope and verify its signatures, canonical rumor ID, sender and recipient, then check its authenticated timestamp against first activation. For a public note or comment, verify the signed event and check its configured source relay, structure, command target and scope. Invalid or ineligible input stops here; it claims nothing and runs no middleware, command or fallback.
2. **Claim.** Atomically insert the canonical ID in the account/mode's SQLite store: the inner rumor ID for a DM, or the signed event ID for public input. A duplicate stops before middleware. Eligible public history still stops after claiming its ID; a later live copy does not run. Incoming DM recovery and live delivery use the same admission rule. Eligible outgoing self copies can populate private history without middleware.
3. **Run middleware once.** An eligible input enters its conversation or public-root queue. Middleware runs in registration order; put `bot.use(allowlist(pubkeys))` first to restrict everything downstream. Returning without `next()` stops routing. If the chain throws, the error is reported through the applicable error handler. In either case the ID stays claimed; reconnect and restart do not reopen it.
4. **Route.** When middleware reaches routing, a DM is saved to private conversation history and can notify receipt observers. Public input has no stored body or conversation history. The SDK invokes the matching scoped command (including argument checks and any command-specific authorization), or the DM fallback if no command matches. The claim is already durable: a crash can leave a callback partially executed or prevent it from running at all.
5. **Publish outgoing events separately.** Sends, replies and reactions are stored before publication. Startup, reconnect or `flushOutbox()` can retry that exact signed event, not the incoming callback. Relay acceptance does not confirm delivery or reading.

## Processing and observations

```ts
const detach = bot.handle(async ctx => {
  await ctx.reply('Thanks');
});

const unobserve = bot.observe(message => {
  // Receipt observation only; no durable success/failure responsibility.
});
```

`handle()` registers the handler for messages with no matching command. It receives the same context as command handlers and can be registered before or after commands. Each Bot has one fallback. Call the returned unsubscribe function before registering a replacement.

`observe()` subscribes to newly admitted DMs retained in local conversation history, using detached copies. It runs once routing is reached and does not control command matching or completion.

Callbacks are serial within a conversation or public root; different queues can proceed concurrently. See the [event processing flow](#event-processing-flow) for the claim, history and outgoing retry boundaries.

`onError(observer)` returns an unsubscribe function. It receives an error and optional verified message context. Observer failures are ignored; there is no SDK default logger.

For callers injecting protocol events, `await bot.receive(event, source, {relay})` reports intake, not handler success. An eligible new ID returns `true` even if access middleware later stops it; a duplicate or ineligible event returns `false`. Public injection requires a configured source relay. Use `await bot.idle()` to drain queued callbacks, not to force retries.

A `Message` contains rumor `id`, identity `sender`, peer `conversation`, `text`, millisecond `timestamp`, `source`, `direction`, verified `rumor`, optional parent `replyTo`, and optional transport `relay`. Relay provenance is not author-signed. Deduplication uses account/mode + rumor ID, not giftwrap ID.

## Sending and history

`send(peerPubkey, nonemptyText, options?)` returns `{id, status}`, where status is `relay-accepted` or `pending`.

### Upload file bytes

```ts
const { url, sha256, size, mimeType } = await bot.uploadFile(bytes, { mimeType: 'image/png' });
```

`uploadFile(bytes, options?)` uploads the supplied bytes as-is, without encryption, to the first configured Blossom server that accepts them. If the bytes are plaintext, people who can access the blob URL can read them. Callers can encrypt bytes themselves before uploading. Pass `mimeType` for the uploaded bytes, or omit it to use `application/octet-stream`. The result contains the verified URL, SHA-256, byte count and MIME sent in the request. The URL must end in the blob hash, with an optional extension, and use the accepting server’s origin or an explicit `blossomDownloadOrigins` entry. This upload does not send any Nostr message or publish a note; callers can use the result to build a public note with an `imeta` tag.

### Send a private file

Pass the file bytes, not a URL or a path. Configure the servers when constructing the bot:

```ts
import { readFile } from 'node:fs/promises';
import { Bot } from 'chirli';

const bot = new Bot({ signer, blossomServers: ['https://files.example.com'] });
await bot.start();
const result = await bot.sendFile(peerPubkey, await readFile('report.pdf'), {
  name: 'report.pdf',
  mimeType: 'application/pdf',
});
```

`sendFile(peerPubkey, bytes, options?)` accepts a nonempty `Uint8Array` (including a Node.js `Buffer`) up to an encrypted upload size of 64 MiB. It encrypts first, then uses the same `uploadFile()` path. The optional `name`, `mimeType` (default `application/octet-stream`) and `replyTo` stay inside the encrypted attachment message. Like `send()`, it returns the message ID and `relay-accepted` or `pending` after an upload succeeds. The relay outbox retries the same encrypted message without uploading again; if all uploads fail, the call rejects and queues no message. A successful upload can remain on the server if the later message send fails.

By default Chirli uses the exported `DEFAULT_BLOSSOM_SERVERS` list. An explicit list replaces it entirely. `start()` and `announce()` publish the ordered BUD-03 kind 10063 list to `writeRelays` and `discoveryRelays`, not to DM-only relays. With `blossomServers: []`, Chirli publishes no Blossom list and does not clear an existing public list. Use HTTPS URLs with no credentials, query or fragment. Explicit HTTP loopback URLs are allowed for development. Chirli tries only the configured servers, in order. After the first upload succeeds, it tries BUD-04 mirroring concurrently on the remaining configured servers. Mirrors are best-effort: failures do not change the successful upload result. Mirror requests reuse the successful upload authorization and have a 10-second HTTP timeout. The authorization is restricted to configured server hostnames; mirrors never ask the signer to sign again. No unconfigured server is used.

The server receives ciphertext, ciphertext size/hash and a signed upload authorization identifying the bot. The recipient gets the URL and decryption metadata inside a NIP-17 kind-15 gift wrap. Chirli stores outgoing file metadata in local message history like other messages; use `storageKey` (and an appropriate custom store, if configured) to protect it at rest. This API sends private files only. Incoming file handling and downloading are not provided.

See [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) and [Blossom server lists](https://github.com/hzrd149/blossom/blob/master/buds/03.md).

### Reply with a private or public file

```ts
await ctx.replyFile(bytes, { mimeType: 'image/png', name: 'report.png' });
await bot.replyFile(event, bytes, { mimeType: 'image/png' }); // Outside the handler.
```

`bot.replyFile` takes the same original `ctx.input.event` as `bot.reply`, not an event ID. Both forms return the normal send result. The anchor decides the visibility:

- Authenticated kind-14 DM: encrypt the bytes and send a kind-15 DM with a reference to the triggering rumor. The optional filename is inside the encrypted message.
- Signed kind 1/1111: **upload the supplied bytes as-is and publicly post the URL**. The reply is kind 1111 with the same root, parent and relay routing as `reply()`, plus an `imeta` tag. The DM filename option is ignored on this path. Only use this form with bytes you intend to publish.

For a new top-level public note rather than a reply, `uploadFile()` supplies the blob metadata; Chirli does not create the kind-1 note.

### Replies and references

To reference an earlier DM explicitly, pass its ID:

```ts
await ctx.reply('Got it', { replyTo: ctx.input.id }); // Within a DM handler.
await bot.send(peerPubkey, 'Follow-up', { replyTo: earlierMessage.id });
```

`replyTo` is the lowercase hex kind-14 message ID. The SDK writes it as an `e` tag inside the encrypted message. Stored private `Message` objects include the optional parent ID as `message.replyTo`. Omit the option for a plain DM. Public replies instead reference the triggering note/comment automatically and do not accept DM options.

`bot.getMessage(id)` looks across the Bot's local private conversations and returns `undefined` if no message is stored. It does not fetch from relays. Use `ctx.thread()` to load context relative to the current input in a shared handler.

### Reactions

Use `ctx.react('👍')` to react to the current input, or pass the original event to `bot.react(event, '👍')`. The Bot method takes an event, not an ID. Omit the reaction string to send `+` (like). Pass a Unicode emoji or other nonblank reaction text; custom image emoji are not supported.

- For an authenticated DM, the reaction is a kind-7 rumor inside an encrypted DM envelope and uses the private outbox.
- For a signed public note or comment, the reaction is a public [NIP-25](https://nips.nostr.com/25) kind-7 event written through the durable public outbox. It tags the target event and author; kind-1111 targets also get a `k` tag.

Both methods return `{id, status}` with the same relay acceptance semantics as `send()`. Incoming reactions are ignored; reactions do not enter private text history or trigger handlers. See [delayed actions](#replies-and-context-after-a-handler) for what the Bot method verifies.

### Delivery and retries

Discovery, signing and pre-commit persistence errors reject. Once committed, network failure retains exact envelopes, reports through `onError`, and returns pending status. At least one relay ACK per recipient/self envelope is needed; it does not prove delivery or reading. A new send call creates a new logical message.

### Local history

```ts
const page = bot.dmHistory(peerPubkey, { limit: 20 });
if (page.nextCursor) {
  const older = bot.dmHistory(peerPubkey, { cursor: page.nextCursor });
}
```

History is synchronous local storage access: newest timestamp first, then ascending ID. Default limit is 30, capped at 100. Each page includes `messages`, optional `nextCursor`, `coverage: 'local-only'`, and `complete: false`. The current incoming message and outgoing replies may be present; select context explicitly.

## Private history inspection and sessions

| Method | Result |
| --- | --- |
| `getMessage(id)` | A stored private message, or undefined |
| `getMessageState(id)` | Diagnostic status of a stored private message, or undefined |
| `listMessages({state?,limit?,cursor?})` | `{entries,nextCursor?}`, ordered timestamp/ID ascending |
| `await getSession(peer)` | Read the saved session from the configured backend |
| `await setSession(peer, value)` | Replace the saved snapshot in the configured backend |

Message list limits are 1..100, default 30. These APIs describe retained private history, not the internal set of claimed IDs. A DM short-circuited by middleware may have a durable ID claim without a history record. Status values never trigger retries.

Arbitrary external effects and session saves are not atomic; applications own idempotency.

## Bot middleware

Every handler has a conversation-scoped `ctx.session` with `getItem`, `setItem`, `removeItem` and `clear`. See [conversation sessions](SESSIONS.md) for defaults, commit behavior, and a complete custom storage example.

| Method | Behavior |
| --- | --- |
| `use(fn)` | Append middleware before message routing |
| `command(definition, fn, options?)` | Register an explicitly scoped command with an optional typed argument schema |
| `handle(fn)` | Register the handler for messages with no matching command |
| `catch(observer)` | Observe session/middleware failures without consuming them |
| `getCommandDefinitions()` | Detached snapshots of this Bot's active definitions |

Use `bot.use()` to register Koa-style middleware. Each layer receives the same `ctx` and runs in registration order before routing. Call `next()` at most once; returning without it stops routing.

Routing calls the first matching command with `(ctx, args)`. If none matches, it calls the handler registered with `handle(ctx => …)`. Authorization denial for a matching command ends routing. Both kinds of handler use the same context: `input`, `sender`, `conversation`, `session`, `reply`, `replyFile`, `react` and `thread`.

When args is a Zod 4 object, TypeScript infers its validated output in a separate handler-only ctx.args and the existing second handler parameter. The middleware context is not mutated; its property descriptors, methods and shared session are retained on the handler view. Ordinary middleware/fallback Context has no args. Required values are present, optional values include `undefined`, and enum values use the declared choices. For a definition stored in a separate variable, use `as const satisfies BotCommandDefinition` to preserve its literal types. A dynamic definition exposes unknown argument values until narrowed.

The published `d` equals the command name; custom `id` and the old string shorthand are rejected. Supply `scopes` containing at least one distinct `kind:14`, `kind:1` or `kind:1111`; no kind is inserted implicitly. The same scopes govern publication and authenticated routing. `authorize(ctx, invocation)` controls execution independently of public metadata.

`ctx.input` and `await ctx.thread({limit})` work across private and public input. `ctx.reply()` and `ctx.react()` stay encrypted for private input and publish kind 1111 and kind 7, respectively, for public input. Use Bot methods for receipt observation and local private history inspection. See [public inputs and threads](PUBLIC.md) for explicit inbox configuration, target rules and coverage limits.

Session load, middleware, fallback and session save share one error boundary. `catch()` observes failures without reopening the ID, and observer failures do not replace the original error. Session writes are buffered and commit when middleware returns successfully, even after an intentional short-circuit; an uncaught exception skips the session commit.

Omit a command from the next startup registry to withdraw it automatically on restart. Closing the Bot preserves the published catalog until that reconciliation. Runtime additions remain supported; runtime removal is not exposed.

## Public commands

All command definitions are public on configured write relays. Register the complete local set before startup. Observed remote commands absent locally are withdrawn with kind 5; no separate executor-list event is published. User-installed kind 10992 lists are untouched.

| Method | Behavior |
| --- | --- |
| `syncCommands()` | Reconcile own author-scoped definitions on write relays; return net added/updated/removed IDs across the whole coalesced call |
| `discoverCommands({authors,relays,ids?,limit?})` | Read and verify author-scoped kind 31992 definitions and kind 5 withdrawals; optional ids narrows definitions only |

Command discovery is read-only and returns a bounded relay snapshot with `complete: false`. Neither discovery nor scopes grant execution permission. See [command syntax, schemas and lifecycle](NIP-CD.md).

## Advanced integrations

`await receive(event, 'history' | 'live', {relay}?)` is the verified custom-intake boundary. It returns `true` for a newly claimed eligible DM or public input, or a newly stored own DM copy. An ID claim does not imply that a handler ran or that a payload was stored. Local and remote signers use the same asynchronous path. For DMs, the transport source is diagnostic: the authenticated rumor timestamp and first activation determine eligibility. Classify public source truthfully: old public history presented as live can execute commands.

Custom `Transport` supplies `query`, `subscribe`, `publish` and `close`. Custom subscription readiness retains its existing contract. Direct built-in Transport subscriptions and bounded queries require actual EOSE; SDK-owned long-lived inboxes alone permit the local read-window fallback described in the relay reference. Physical socket health is independent of either completion signal. The built-in transport uses nostr-tools for pooled physical connections, REQ, EOSE timers, keepalive and ACK tracking, with bounded connect/EOSE/ACK/AUTH operations; `InboxSubscription` owns reconnect and recovery. See [relays](RELAYS.md) and [recovery](RECOVERY.md).

`MessageStorage` implements `insert(account, entry)`, `query(account, options)` and `updateState(account, id, state)`. Entries include encoded payloads and diagnostic state. `sqliteMessageStorage(path)` supplies the default indexed backend. Bot creates and closes its default instance; supplied instances remain application-owned. Internal outbox, keys and metadata always use the `database` path. See [storage](STORAGE.md) for query and failure semantics.

`refreshPeer(pubkey)`, `encryptionKeys()` and `rotateEncryptionKey()` expose peer refresh and public key-custody operations. See [keys](KEYS.md) for retention, own-declaration conflicts and mode changes.

Exported `RelayError`, `SignerError`, `StorageEncryptionError` and `Nip4eCompatibilityError` distinguish operational failures. Relay diagnostics sanitize URLs/reasons; application error observers may still see sensitive business context. Optional timing observers cannot alter transport success. See [live diagnostics](../examples/live/README.md#diagnose-slow-replies).

Command removal is expressed by the next startup registry, not a runtime method. `syncCommands()` returns only `added`, `updated`, `removed` and optionally waits/retries automatic synchronization; normal startup and running changes require no manual call. Startup performs broad author-only kind 31992 reads per write relay, without `#d` or remote kind 5 queries. Discovery independently reads 31992 plus kind 5, adding `#d` only when `ids` is supplied, and returns no index result field. Protocol-level `CommandDefinition.id` still denotes an external event's actual `d`, separate from its event hash. See [upgrade details](NIP-CD.md#upgrade-behavior).

## Optional official components

`allowlist(pubkeys: readonly string[])` returns ordinary middleware. Register `bot.use(allowlist(pubkeys))` before middleware whose effects need protection. It validates and snapshots lowercase hex account keys, checks the verified input author, and calls `next()` only for listed senders. `allowlist([])` blocks every external input from routing. The ID is already claimed; the middleware does not run on public history or outgoing self copies. [Sender authorization](ACCESS.md)

`requestTiming({onTiming})` returns ordinary `bot.use()` middleware. Register it before the processing middleware you want to measure. `RequestTiming` is a frozen object containing only readonly `durationMs:number` (monotonic elapsed milliseconds) and `outcome:'success'|'failure'`. `RequestTimingObserver` may return void or a Promise; synchronous exceptions and rejected observer promises are isolated, and the observer is not awaited. Successful processing stays successful, original handler errors stay the same errors and do not trigger a retry. No context, body, sender, event ID, route inferred from text, credentials or raw error is passed to telemetry. There is no default logger.

Timing covers the downstream middleware/command/fallback chain, including reply operations it awaits. It excludes work before this middleware, envelope verification/persistence, queue wait and session persistence after dispatch; a subsequent session-commit error is outside the measured chain outcome. It is neither end-to-end message latency nor a delivery measurement. No route hook or extra framework dependency is introduced.

## Replies and context after a handler

`bot.reply(event,text,options?)`, `bot.replyFile(event,bytes,options?)`, `bot.react(event,reaction?)` and `bot.thread(event,options?)` accept the original `ctx.input.event`: a signed kind 1/1111 Event or an authenticated decrypted kind 14 Rumor. No ID/string, outer gift wrap, context wrapper or token overload is accepted. They use the same routing and visibility as their handler counterparts. Private `replyTo` stays optional and is not inserted implicitly. Public replies reject nonempty DM send options.

```ts
// jobs is an application-owned queue; protect plaintext DM events in its storage.
bot.command({command:'work',scopes:['kind:14','kind:1','kind:1111']}, async ctx => {
  await jobs.add(structuredClone(ctx.input.event));
});

// After the handler finishes, with this Bot started and its account store available:
async function processJob(event: Event | Rumor) {
  const prior = await bot.thread(event, {limit:30});
  const text = await applicationProcessor(prior.entries);
  return bot.reply(event, text);
}
```

The application supplies `jobs` and `applicationProcessor`; Chirli does not schedule or retain jobs. Import `Rumor` from `chirli` and `Event` from `nostr-tools`. Run `npm run example:async-reply` for a fully offline three-kind example.

Public events are cloned and independently reverified on every call, including IDs, signatures, eligible kind and thread structure. A retained full signed event works after completion/restart. The SDK stores no public input body or source relay for delayed calls. Delayed replies and reactions use configured write relays only; immediate handler calls can also use the configured inbox relay that delivered the input. Neither path trusts relay hints from tags. Thread queries use the configured public inbox. The public inbox must be configured.

A rumor has no standalone signature. The SDK requires an exact match with the current account/mode's persisted authenticated incoming DM record: hash, canonical fields/tags, sender, recipient, private conversation, text, timestamp and reply reference. Missing records, outgoing self copies, other accounts, changed rumors and outer envelopes are rejected. Reopen with the same signer, database, message backend, mode and any storage key; retaining a rumor alone cannot reconstruct its authentication. DM thread context remains anchored to the saved trigger and excludes later conversation entries.

Calls snapshot the event before asynchronous work, and handler methods retain separate internal snapshots. Mutating a caller object does not retarget an in-flight operation; supplying an already altered object fails verification. Calls require a started/open Bot instance and reject after close. These methods never invoke inbound handlers or provide a queue, token, idempotency key or exactly-once guarantee. Repeating a reply or reaction call creates a new outgoing action; use application idempotency and `flushOutbox()` for already pending sends. These are explicit application actions, not a second inbound authorization hook; allowlist is not an outbound ACL. Saved DM events contain plaintext and must not be logged or placed in an unprotected job store.

## Zod command arguments

Declare Zod 4 as an application dependency, import `z` from `zod`, and pass one object directly as `args`. No argument-builder API, second schema or per-command error callback is needed.

```ts
import {z} from 'zod';
import {InvalidArgsError} from 'chirli';

bot.use(async (ctx, next) => {
  try { await next(); }
  catch (error) {
    if (!(error instanceof InvalidArgsError)) throw error;
    await ctx.reply(`Usage error for /${error.command}`);
  }
});

bot.command({
  command:'pick', scopes:['kind:14','kind:1','kind:1111'],
  args:z.object({
    user:z.string().meta({label:'User',nipcdType:'pubkey'}),
    count:z.bigint().min(1n).max(10n).meta({label:'Count'}),
    mode:z.enum(['short','full']).optional().meta({label:'Mode'}),
  }),
}, async (ctx, args) => {
  // ctx.args and args are the same validated result; count is bigint.
  await ctx.reply(`${ctx.args.mode ?? 'short'}: ${args.count}`);
});
```

Field names and insertion order generate NIP-CD positional names/order. `optional()` sets required=false. Labels come from field `.meta({label})`, defaulting to the name. String → word, bigint → number, boolean → bool and string enum → enum/choices are inferred. Annotate strings with `nipcdType:'text'|'pubkey'|'event'|'relay'` when needed. For address use `.meta({nipcdType:'address'})` on `z.object({kind:z.number().int(),pubkey:z.string(),identifier:z.string(),relays:z.array(z.string())})`; decoder output matches the existing CommandAddress structure. Constraints/refinements run on decoded values, including asynchronous refinements.

The supported subset is deliberately bounded: top-level object with no __proto__ field, those scalar types, one optional wrapper per field, and the documented address object. Transforms/pipes, overwrites (including trim/normalize), coercion, defaults, nullable/union/lazy schemas, loose/catchall objects and arbitrary arrays/nested objects are rejected at registration. Validator exceptions are business errors, not normal schema rejection. Existing wire restrictions remain: unsigned protocol number tokens decode as bigint; required fields precede optional ones; at most one optional field; text is final. Zod min/max/refinements are local validation, not extra 31992 tags. No arbitrary transformations are inferred. Metadata should be attached to the field schema; use optional().meta(...) for optional fields.

Registration still automatically publishes the derived CommandArgument[] in the existing kind 31992 format; encode/decode/discovery and protocol CommandDefinition/CommandArgument stay unchanged. `getCommandDefinitions()` returns derived wire definitions, suitable for the pure `parseCommand()` helper. Old Bot args arrays must migrate to z.object; pure protocol helpers continue accepting wire arrays.

After middleware, routing first verifies command/target/scopes, then decodes and validates. A matched command's missing/invalid/extra arguments or Zod rejection raises `InvalidArgsError` with command, category (`decode` or `validation`) and bounded safe issues containing only code and registered field path. Submitted values, custom issue messages, raw decoder reasons and arbitrary custom paths are omitted. It never falls through to plain handling. Middleware may catch around await next(); otherwise bot.catch observes it once. With neither handler, it completes silently without an automatic response or retry. An uncaught framework InvalidArgsError skips the session commit; middleware that catches and returns successfully can commit its intentional session writes. The exact framework-generated error is handled separately from application-created errors, which are reported as ordinary failures. Neither path reruns the input.

If a command uses args-dependent `authorize`, malformed input is silently consumed: no validation-error callback is exposed because invalid arguments cannot authorize an error response. Validator exceptions before authorization are retained internally until middleware unwinds, then reported unchanged to operational `onError`. They bypass middleware catch and bot.catch, cannot authorize an error reply, and do not commit sessions. Validators without authorize and other business errors retain existing error-chain semantics. For valid data authorize receives the validated invocation.args before the business handler. No new response-authorization or per-command error callback is introduced. Wrong targets/scopes and early middleware stops never generate a command-argument error. Public initial admission remains restricted to known, genuinely targeted and scoped invocations; historical/repeated work does not replay error handlers.

Official requestTiming also reports failure for a validator exception deferred until after middleware because command authorization has not run. Its internal signal contains only failure state, without exposing the original exception or changing next() behavior. Operational `onError` observes that failure; no callback is retried.

### Command synchronization result across rounds

Concurrent syncCommands calls share one in-flight promise. If registrations change during reconciliation or public-subscription EOSE, it repeats until the current registry is synchronized and returns combined added/updated/removed IDs across every completed round of that promise, including rounds before a caller joined it. Each ID appears at most once, in one category, ordered by its first observed change. Added then updated remains added; added then removed disappears from the net result; updated then removed becomes removed; removed then re-added becomes updated. Updated means a previously present coordinate changed during this operation and ends present, even if its original content was restored. These are net presence deltas from the low-level observed per-round differences, not a global relay archive/content diff. The low-level journal, signed event IDs, ACK requirements and per-round reconciliation are unchanged. Failure/cancellation rejects instead of returning partial results; already published durable work is not rolled back.

A rejected initial public-subscription read is not readiness. Retrying the same kinds can create a fresh subscription; configured automatic reconnect can also recover its managed subscription. Stale failed attempts cannot close a newer subscription, and stop fences late readiness callbacks.
