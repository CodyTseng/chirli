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
| `messageStorage` | Message records and processing state; defaults to `sqliteMessageStorage` |
| `sessionStore` | Optional backend for conversation state. See the [custom store example](SESSIONS.md#use-a-custom-session-store). |
| `storageKey` | Optional 32-byte local encryption key; omission selects tagged plaintext |
| `transport` | Injected `Transport`; exclusive with `transportOptions` |
| `transportOptions` | Default WebSocket timeouts and query concurrency |
| `relays` | Nonempty shorthand for each omitted relay role |
| `dmRelays` | Inbox/delivery role; nonempty |
| `readRelays` | Metadata discovery role; `[]` is allowed |
| `writeRelays` | Public metadata/command role; nonempty |
| `allowlist` | Legacy canonical identity pubkeys; omitted accepts all, `[]` denies external senders |
| `inboundPolicy` | Optional synchronous verified-sender policy; use exported `allowlist(pubkeys)` before persistence; combines restrictively with legacy allowlist |
| `mode` | `nip17` default, or explicit `nip4e` split messaging keys |
| `keyRotation` | Omitted/false, or split-mode rotation settings; see [keys](KEYS.md) |
| `nip4eCompatibility` | False suppresses identity-key 10044 publication; dual intake stays enabled |
| `reconnect` | Retry settings or false; enabled by default |
| `recovery` | Bounded history settings or false; enabled by default |
| `historyLimit` | Initial per-relay giftwrap request limit; default 500 |
| `metadataCache` | Peer cache settings or false; see [relays](RELAYS.md) |
| `keySync` | Same-identity split-key sync settings or false; see [keys](KEYS.md) |

Omitted relay roles use exported `DEFAULT_DM_RELAYS`, `DEFAULT_READ_RELAYS` and `DEFAULT_WRITE_RELAYS`. The account, mode and storage codec are fixed for a Bot's lifetime. Preserve credentials, database and any storage key after restart.

## Lifecycle

| Method | Behavior |
| --- | --- |
| `announce(options?)` | Explicitly publish account key/relay metadata and synchronize registered commands |
| `start()` | Resolve the signer, publish key/relay metadata, synchronize commands, open inbox and retry persisted work |
| `idle()` | Drain ordered crypto intake and currently queued handlers |
| `requestStop()` | Request shutdown from a handler without awaiting its own drain |
| `stop()` | Cancel subscriptions/timers/recovery and drain current work; Bot stays reusable |
| `close()` | Stop and release internally owned resources; idempotent |
| `syncHistory()` | Scan running subscriptions' bounded recovery windows |
| `flushAnnouncements()` | Retry pending account metadata and dirty/pending command state |
| `flushOutbox()` | Retry persisted message bundles; aggregate failures after attempting the snapshot |

Concurrent start calls share readiness/failure; a start during stop waits for teardown. Startup requires one ready DM replica, while command reconciliation requires every write relay. Other DM replicas can continue recovering. History scans may report incomplete coverage without failing startup. Start does not await every business handler.

`idle()` is not a remote synchronization or delivery barrier. `idle()`, `retryInbox()`, `stop()` and `close()` reject inside message handlers because they would wait on themselves. Use `requestStop()` there, then drain outside the handler.

Await application-owned sends and stop/await application timers before closing Bot. SDK shutdown drains its own work; it cannot cancel arbitrary application effects. One active Bot/process per account database is supported.

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

`observe()` subscribes to new incoming live receipts using detached copies. An observer runs independently of command matching and message completion. Use it for receipt monitoring.

Commands, middleware and the fallback share durable processing. If any step fails, earlier effects may repeat on retry. Conversation queues are serial, and separate conversations can proceed concurrently. Historical messages and outgoing self copies are stored without dispatch.

`onError(observer)` returns an unsubscribe function. It receives an error and optional verified message context. Observer failures are ignored; there is no SDK default logger.

A `Message` contains rumor `id`, identity `sender`, peer `conversation`, `text`, millisecond `timestamp`, `source`, `direction`, verified `rumor`, optional parent `replyTo`, and optional transport `relay`. Relay provenance is not author-signed. Deduplication uses account/mode + rumor ID, not giftwrap ID.

## Sending and history

`send(peerPubkey, nonemptyText, options?)` returns `{id, status}`, where status is `relay-accepted` or `pending`.

### Replies and references

To reply to a message, pass its ID:

```ts
await ctx.reply('Got it', { replyTo: ctx.message.id });
await bot.send(peerPubkey, 'Follow-up', { replyTo: earlierMessage.id });
```

`replyTo` is the lowercase hex kind-14 message ID. The SDK writes it as an `e` tag inside the encrypted message. Message objects include the optional parent ID as `message.replyTo` for live messages, history and local lookups. Omit the option for a plain DM.

```ts
const parentId = ctx.message.replyTo;
const parent = parentId === undefined ? undefined : ctx.getMessage(parentId);
```

`ctx.getMessage(id)` looks in the current conversation. `bot.getMessage(id)` looks across the Bot's local conversations. Both query the configured message store by ID and return `undefined` when the message is missing. Lookup does not fetch from relays.

### Reactions

Send a private reaction to the current message with `ctx.react('👍')`, or use `bot.react(messageId, '👍')` for a message in local history. Omitting the reaction sends `+` (like). To react to a different message in the handler's conversation, use `ctx.react('👍', messageId)`. The target ID determines the conversation. A missing target rejects.

Reactions use a kind-7 rumor inside the same encrypted DM envelope and durable outbox as text messages. Both reaction methods return `{id, status}` with the same relay acceptance semantics as `send()`. Incoming reactions are ignored, and reactions do not appear in text history or trigger text handlers.

### Delivery and retries

Discovery, signing and pre-commit persistence errors reject. Once committed, network failure retains exact envelopes, reports through `onError`, and returns pending status. At least one relay ACK per recipient/self envelope is needed; it does not prove delivery or reading. A new send call creates a new logical message.

### Local history

```ts
const page = bot.history(peerPubkey, { limit: 20 });
if (page.nextCursor) {
  const older = bot.history(peerPubkey, { cursor: page.nextCursor });
}
```

History is synchronous local storage access: newest timestamp first, then ascending ID. Default limit is 30, capped at 100. Each page includes `messages`, optional `nextCursor`, `coverage: 'local-only'`, and `complete: false`. The current incoming message and outgoing replies may be present; select context explicitly.

## Message state and sessions

| Method | Result |
| --- | --- |
| `getMessageState(id)` | `pending`, `processing`, `failed`, `done`, or undefined |
| `listMessages({state?,limit?,cursor?})` | `{entries,nextCursor?}`, ordered timestamp/ID ascending |
| `retryInbox({ids?})` | Retry unfinished work; omitted IDs selects all, `[]` selects none |
| `await getSession(peer)` | Read the saved session from the configured backend |
| `await setSession(peer, value)` | Replace the saved snapshot in the configured backend |

Message list limits are 1..100, default 30. Done/unknown IDs are ignored by retry. Inspection, history, deduplication and retry recovery all use the configured message backend.

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

Use `use()` to register middleware. It runs in registration order and receives `(ctx, next)`. Await `next()` to continue to later middleware and routing. Middleware can return early to stop processing.

Routing calls the first matching command with `(ctx, args)`. If none matches, it calls the handler registered with `handle(ctx => …)`. Authorization denial for a matching command ends routing. Context provides `message`, `sender`, `conversation`, `reply`, `react`, `getMessage`, `history`, and `session`.

When args is a Zod 4 object, TypeScript infers its validated output in a separate handler-only ctx.args and the existing second handler parameter. The middleware context is not mutated; its property descriptors, methods and shared session are retained on the handler view. Ordinary middleware/fallback Context has no args. Required values are present, optional values include `undefined`, and enum values use the declared choices. For a definition stored in a separate variable, use `as const satisfies BotCommandDefinition` to preserve its literal types. A dynamic definition exposes unknown argument values until narrowed.

The published `d` equals the command name; custom `id` and the old string shorthand are rejected. Supply `scopes` containing at least one distinct `kind:14`, `kind:1` or `kind:1111`; no kind is inserted implicitly. The same scopes govern publication and authenticated routing. `authorize(ctx, invocation)` controls execution independently of public metadata.

`ctx.input` and `await ctx.thread({limit})` work across private and public input. `ctx.reply()` stays encrypted for private input and publishes kind 1111 for public input. `message`, `history`, `react` and `getMessage` are DM-only compatibility methods and throw on public input. Receipt observation and message inspection APIs still describe DMs. See [public inputs and threads](PUBLIC.md) for explicit inbox configuration, target rules and coverage limits.

Session load, middleware, fallback and session save share one error boundary. `catch()` cannot mark failed work successful, and observer failures do not replace the original error. Sessions save only after successful processing.

Omit a command from the next startup registry to withdraw it automatically on restart. Closing the Bot preserves the published catalog until that reconciliation. Runtime additions remain supported; runtime removal is not exposed.

## Public commands

All command definitions are public on configured write relays. Register the complete local set before startup. Observed remote commands absent locally are withdrawn with kind 5; no separate executor-list event is published. User-installed kind 10992 lists are untouched.

| Method | Behavior |
| --- | --- |
| `syncCommands()` | Reconcile own author-scoped definitions on write relays; return net added/updated/removed IDs across the whole coalesced call |
| `discoverCommands({authors,relays,ids?,limit?})` | Read and verify author-scoped kind 31992 definitions and kind 5 withdrawals; optional ids narrows definitions only |

Command discovery is read-only and returns a bounded relay snapshot with `complete: false`. Neither discovery nor scopes grant execution permission. See [command syntax, schemas and lifecycle](NIP-CD.md).

## Advanced integrations

`await receive(event, 'history' | 'live', {relay}?)` is the verified custom-intake boundary. It returns whether a new supported rumor was stored. Local and remote signers use the same asynchronous path. Classify source truthfully: old history presented as live can execute commands.

Custom `Transport` supplies `query`, `subscribe`, `publish` and `close`. Subscription readiness requires actual EOSE. The built-in transport pools connections and bounds connect/EOSE/ACK/AUTH operations; `InboxSubscription` owns reconnect and recovery. See [relays](RELAYS.md) and [recovery](RECOVERY.md).

`MessageStorage` implements `insert(account, entry)`, `query(account, options)` and `updateState(account, id, state)`. Entries include encoded payloads and processing state. `sqliteMessageStorage(path)` supplies the default indexed backend. Bot creates and closes its default instance; supplied instances remain application-owned. Internal outbox, keys and metadata always use the `database` path. See [storage](STORAGE.md) for query and failure semantics.

`refreshPeer(pubkey)`, `encryptionKeys()` and `rotateEncryptionKey()` expose peer refresh and public key-custody operations. See [keys](KEYS.md) for retention, own-declaration conflicts and mode changes.

Exported `RelayError`, `SignerError`, `StorageEncryptionError` and `Nip4eCompatibilityError` distinguish operational failures. Relay diagnostics sanitize URLs/reasons; application error observers may still see sensitive business context. Optional timing observers cannot alter transport success. See [live diagnostics](../examples/live/README.md#diagnose-slow-replies).

Command removal is expressed by the next startup registry, not a runtime method. `syncCommands()` returns only `added`, `updated`, `removed` and optionally waits/retries automatic synchronization; normal startup and running changes require no manual call. Startup performs broad author-only kind 31992 reads per write relay, without `#d` or remote kind 5 queries. Discovery independently reads 31992 plus kind 5, adding `#d` only when `ids` is supplied, and returns no index result field. Protocol-level `CommandDefinition.id` still denotes an external event's actual `d`, separate from its event hash. See [upgrade details](NIP-CD.md#upgrade-behavior).

## Optional official components

`allowlist(pubkeys:readonly string[]):InboundPolicy` snapshots and validates lowercase hex identity keys. Configure `inboundPolicy:allowlist(pubkeys)` in Bot options. `InboundPolicy` is `(authenticatedSender:string)=>boolean`, evaluated synchronously after envelope/author verification and before receipt persistence, and again before pending startup/retry business work. The legacy `allowlist` option delegates to the same function; both policies compose with AND, retaining own-copy bypass. Empty denies all external senders. See [ACCESS.md](ACCESS.md#official-inbound-policy).

`requestTiming({onTiming})` returns ordinary `bot.use()` middleware. Register it before the processing middleware you want to measure. `RequestTiming` is a frozen object containing only readonly `durationMs:number` (monotonic elapsed milliseconds) and `outcome:'success'|'failure'`. `RequestTimingObserver` may return void or a Promise; synchronous exceptions and rejected observer promises are isolated, and the observer is not awaited. Successful processing stays successful, original handler errors stay the same errors and remain retryable. No context, body, sender, event ID, route inferred from text, credentials or raw error is passed to telemetry. There is no default logger.

Timing covers the downstream middleware/command/fallback chain, including reply operations it awaits. It excludes work before this middleware, envelope verification/persistence, queue wait and session persistence after dispatch; a subsequent session-commit error is outside the measured chain outcome. It is neither end-to-end message latency nor a delivery measurement. No route hook or extra framework dependency is introduced.

## Replies and context after a handler

`await bot.reply(event,text,options?)` and `await bot.thread(event,options?)` accept exactly the original `ctx.input.event`: a signed kind 1/1111 Event or an authenticated decrypted kind 14 Rumor. No ID/string, outer gift wrap, context wrapper or token overload is accepted. These methods use the same internal execution as `ctx.reply` and `ctx.thread`; return values, option handling, thread bounds and failures are shared. Private `replyTo` stays optional and is not inserted implicitly. Public replies reject nonempty DM send options.

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

Public events are cloned and independently reverified on every call, including IDs, signatures, eligible kind and thread structure. A retained full signed event works after completion/restart even though the public journal removes completed bodies. Known source routing comes only from the SDK's retained local journal, never event tags or a caller-supplied relay. If provenance is unavailable/evicted or that inbox is no longer configured, reply routing uses configured write relays only. Thread queries use the configured public inbox. The public inbox must be configured.

A rumor has no standalone signature. The SDK requires an exact match with the current account/mode's persisted authenticated incoming DM record: hash, canonical fields/tags, sender, recipient, private conversation, text, timestamp and reply reference. Missing records, outgoing self copies, other accounts, changed rumors and outer envelopes are rejected. Reopen with the same signer, database, message backend, mode and any storage key; retaining a rumor alone cannot reconstruct its authentication. DM thread context remains anchored to the saved trigger and excludes later conversation entries.

Calls snapshot the event before asynchronous work, and handler methods retain separate internal snapshots. Mutating a caller object does not retarget an in-flight operation; supplying an already altered object fails verification. Calls require a started/open Bot instance and reject after close. Neither method invokes inbound handlers or provides a queue, token, idempotency key or exactly-once guarantee. Repeating a reply call creates a new logical reply; use application idempotency and `flushOutbox()` for already pending sends. These are explicit application actions, not a second inbound authorization hook; allowlist is not an outbound ACL. Saved DM events contain plaintext and must not be logged or placed in an unprotected job store.

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

After entry policy and middleware, routing first verifies command/target/scopes, then decodes and validates. A matched command's missing/invalid/extra arguments or Zod rejection raises `InvalidArgsError` with command, category (`decode` or `validation`) and bounded safe issues containing only code and registered field path. Submitted values, custom issue messages, raw decoder reasons and arbitrary custom paths are omitted. It never falls through to plain handling. Middleware may catch around await next(); otherwise bot.catch observes it once. With neither handler, it completes silently without an automatic response or retry. An uncaught framework InvalidArgsError skips the session commit; middleware that catches and returns successfully can commit its intentional session writes. Only the exact framework-generated error for that dispatch is terminal; other business/middleware errors (even application-created InvalidArgsError) keep failed/report/retry behavior.

If a command uses args-dependent `authorize`, malformed input is silently consumed: no validation-error callback is exposed because invalid arguments cannot authorize an error response. Validator exceptions before authorization are retained internally until middleware unwinds, then sent unchanged to the inbox failed/report/retry path. They bypass middleware catch and bot.catch, cannot authorize an error reply, and do not commit sessions. Validators without authorize and other business errors retain existing error-chain semantics. For valid data authorize receives the validated invocation.args before the business handler. No new response-authorization or per-command error callback is introduced. Wrong targets/scopes and entry-policy denials never generate a command-argument error. Public initial admission remains restricted to known, genuinely targeted and scoped invocations; historical/repeated work does not replay error handlers.

Official requestTiming also reports failure for a validator exception deferred until after middleware because command authorization has not run. Its internal signal contains only failure state, without exposing the original exception or changing next() behavior. Operational onError and inbox retry semantics remain unchanged.

### Command synchronization result across rounds

Concurrent syncCommands calls share one in-flight promise. If registrations change during reconciliation or public-subscription EOSE, it repeats until the current registry is synchronized and returns combined added/updated/removed IDs across every completed round of that promise, including rounds before a caller joined it. Each ID appears at most once, in one category, ordered by its first observed change. Added then updated remains added; added then removed disappears from the net result; updated then removed becomes removed; removed then re-added becomes updated. Updated means a previously present coordinate changed during this operation and ends present, even if its original content was restored. These are net presence deltas from the low-level observed per-round differences, not a global relay archive/content diff. The low-level journal, signed event IDs, ACK requirements and per-round reconciliation are unchanged. Failure/cancellation rejects instead of returning partial results; already published durable work is not rolled back.

A rejected initial public-subscription EOSE is not readiness. Retrying the same kinds can create a fresh subscription; configured automatic reconnect can also recover its managed subscription. Stale failed attempts cannot close a newer subscription, and stop fences late readiness callbacks.
