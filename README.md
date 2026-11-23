# Chirli

A TypeScript SDK for Nostr bots with private messages, public note/comment commands, middleware and persistent sessions.

**Node.js 24+ · ESM · Experimental · Not yet published to npm**

Applications choose what to process and which external services to call. The SDK has no built-in AI provider or automatic history upload.

## Try a bot

Run the commands bot from this checkout:

```sh
npm ci --ignore-scripts
npm run build
npm run bot:commands
```

Wait for the ready banner, then send `/ping` to the printed npub. The identity appears only after startup completes. Press Ctrl+C to stop.

The runner creates persistent credentials and a database on first launch. Configuration is optional; local storage is **plaintext unless a storage key is supplied**. Wire messages remain encrypted.

| Command | Example |
| --- | --- |
| `npm run bot:commands` | `/help`, `/ping`, `/whoami` |
| `npm run bot:echo` | Reply to incoming text |
| `npm run bot:session` | Persist conversation state |
| `npm run bot:notes` | `/remember`, `/notes` |

See [live setup](examples/live/README.md) for credentials, bunker authorization, relays and diagnostics. To explore without external connections, run `npm run examples:smoke` after building.

## Build your own bot

For a guided path from the runnable demo to your own application, see the [first bot tutorial](docs/TUTORIAL.md).

Select a signer at the application boundary. This example reads an application-provided nsec from `CHIRLI_NSEC`:

```ts
import { Bot, nsecSigner } from 'chirli';

const signer = nsecSigner(process.env.CHIRLI_NSEC!);
const bot = new Bot({
  signer,
  database: './chirli.sqlite',
});


bot.command({ command: 'ping', scopes: ['kind:14'] }, async ctx => {
  await ctx.reply('pong');
});

try {
  await bot.start();

  console.log(`Bot public key: ${bot.pubkey}`);
  await new Promise<void>(resolve => {
    process.once('SIGINT', () => resolve());
  });
} finally {
  await bot.close();
  await signer.close();
}
```

Register the complete command set before starting. `bot.start()` resolves the signer, publishes account and inbox metadata, synchronizes commands on write relays, and opens the inbox.

### Use a remote signer

Replace the signer without changing handlers:

```ts
import { bunkerSigner } from 'chirli';

const signer = bunkerSigner(bunkerUri);
```

Pass this signer to `new Bot({ signer })`. After startup, `bot.pubkey` gives you the account key. Approve requests in the signer or configure its permissions ahead of time. See [remote signers](docs/SIGNERS.md#remote-bunker).

## Handle ordinary messages

Use `handle()` to reply to messages that have no matching command:

```ts
bot.handle(async ctx => {
  await ctx.reply('Thanks for your message');
});

bot.onError((error, message) => {
  // Forward sanitized diagnostics to your application's monitoring.
});
```

Handlers run serially within a conversation and concurrently across conversations. A failure leaves the message retryable. Historical messages and outgoing self copies are stored without running handlers.

`observe(observer)` observes a new receipt; it does not participate in durable processing. Register handlers before `start()`.

To reference the current message in a reply, pass its ID to `ctx.reply()`:

```ts
await ctx.reply('Got it', { replyTo: ctx.message.id });

const parentId = ctx.message.replyTo;
const parent = parentId === undefined ? undefined : ctx.getMessage(parentId);
```

Use `bot.getMessage(id)` to look up a local message by ID outside a handler. To send a reaction instead, call `ctx.react('👍')` or `bot.react(id, '👍')`.

### Inspect and retry

```ts
const result = await bot.send(peerPubkey, 'Hello');
// result.status: 'relay-accepted' | 'pending'

const page = bot.history(peerPubkey, { limit: 20 });
const state = bot.getMessageState(messageId);

await bot.retryInbox({ ids: [messageId] });
await bot.flushOutbox();
```

Rumor IDs prevent duplicate intake across relays and restarts. Failed handlers may repeat application effects: use the message ID for application idempotency. Outbox retries reuse the original signed envelopes. Relay acceptance does not confirm delivery or reading.

History is local and paginated. Pass `page.nextCursor` to retrieve older rows; a local page does not imply a complete relay archive.

## Commands and sessions

```ts
const bot = new Bot<{ visits: number }>({
  signer,
  database: './chirli.sqlite',
});

bot.command({ command: 'visit', scopes: ['kind:14'] }, async ctx => {
  const visits = (await ctx.session.getItem('visits') ?? 0) + 1;
  ctx.session.setItem('visits', visits);
  await ctx.reply(`Visit ${visits}`);
});

bot.handle(async ctx => {
  await ctx.reply('Try /visit');
});
```

Register shared middleware with `bot.use((ctx, next) => ...)`. Middleware runs in registration order before routing. After middleware calls `next()`, the first matching command handles the message. When no command matches, the message goes to `bot.handle()`. Sessions are saved after successful processing and survive restart with persistent storage.

Declare a typed argument schema in `command()` for typed arguments. Here `value` is inferred as `bigint`, and the published `d` is `count`.

```ts
import {z} from 'zod';

bot.command(
  {
    command: 'count', scopes: ['kind:14'],
    title: 'Count',
    description: 'Read an unsigned count.',
    args: z.object({ value: z.bigint().meta({label:'Value'}) }),
  },
  async (ctx, { value }) => {
    await ctx.reply(String(value));
  },
);

```

To remove or rename a command, update the declared command set and restart with the same account and relay configuration. Startup automatically withdraws definitions absent from the new registry. There is no runtime removal method.

All registered commands are public on write relays. Startup adds or updates definitions and withdraws commands absent from the local registry. Definitions use kind `31992` and withdrawals use kind `5`; there is no executor-list event. User-installed kind `10992` lists are untouched.

Definitions and scopes grant no execution permission. Configure `allowlist` on Bot or an `authorize` callback for individual typed commands. See [command lifecycle](docs/NIP-CD.md) and [sender authorization](docs/ACCESS.md).

## Configuration

| Option | Purpose |
| --- | --- |
| `signer` | Required account signing and NIP-44 capabilities |
| `database` | SQLite path; defaults to `psstpsst.sqlite` |
| `messageStorage` | Message backend; defaults to `sqliteMessageStorage` |
| `storageKey` | Optional 32-byte key for local payload encryption |
| `allowlist` | Allowed sender public keys; omitted accepts all, `[]` denies all |
| `relays` | Common defaults for the three relay roles |
| `dmRelays` | Receive and deliver private messages |
| `readRelays` | Query public metadata |
| `writeRelays` | Publish public commands and account metadata |
| `mode` | `nip17` by default; `nip4e` enables separate messaging keys |

Preserve signer credentials, the database and any storage key across restarts. `messageStorage` stores messages, deduplication and processing state; it defaults to `sqliteMessageStorage` in the configured database. Supply `sqliteMessageStorage('./messages.sqlite')` or implement `insert`, `query` and `updateState` to use another message backend. Outbox, keys and other internal data always use SQLite configured by `database`. Custom `Transport` implementations are also supported.

### Resource lifecycle

The component that creates a resource closes it:

- Bot closes its built-in transport and storage.
- Your application closes injected signers, transports and storage adapters.
- `bot.stop()` drains handlers and keeps the Bot reusable. `bot.close()` also releases its resources.

Close Bot before its injected resources. Call stop/close outside message handlers; use `bot.requestStop()` when a handler needs to request shutdown.

### Protocol modes and recovery

Default NIP-17 uses account-key encryption. Explicit `mode: 'nip4e'` generates or restores separate messaging keys for extension peers. Both modes accept supported standard NIP-17 and NIP-4E messages.

Relay connections are pooled and reconnect independently. History recovery uses bounded overlap paging. Messages recovered after downtime remain history and do not automatically execute commands.

See [key rotation](docs/KEYS.md), [interoperability](docs/INTEROPERABILITY.md), [relay configuration](docs/RELAYS.md) and [recovery](docs/RECOVERY.md) for detailed behavior and limits.

## Development

```sh
npm run build
npm run typecheck
npm test
npm run examples:smoke
npm run pack:check
```

`npm run check` runs the complete pipeline. Tests use disposable accounts and temporary storage; loopback integration tests require local socket binding. Package checks use a temporary tarball consumer and installed dependencies without registry access.

## Documentation

Start with the [first bot tutorial](docs/TUTORIAL.md) for a step-by-step path from the runnable demo to your own application.

| Guide | Contents |
| --- | --- |
| [API](docs/API.md) | Bot, middleware and public types |
| [Examples](examples/README.md) | Fourteen offline demos and a loopback demo |
| [Sessions](docs/SESSIONS.md) | Conversation state, resets and a custom SQLite session store |
| [Storage](docs/STORAGE.md) | Message adapters, encryption and persistence contracts |
| [Architecture](ARCHITECTURE.md) | Layer boundaries and failure semantics |
| [Contributing](CONTRIBUTING.md) | Development and validation expectations |
| [Security](SECURITY.md) | Trust boundaries and known limitations |

Chirli supports one-to-one private text, reply references, sending reactions, and explicitly scoped kind 1/1111 public commands. See [public inputs and threads](docs/PUBLIC.md). Groups, attachments, full archive recovery and exactly-once external effects are outside its scope. One active Bot/process per account database is supported. Public relays, external signer products and production deployments require separate validation.

Bot command identifiers come from their command names; custom `id` parameters are rejected. Renaming a command removes the old coordinate and adds the new one. Startup compares one broad author-scoped kind 31992 scan per write relay with the complete local registry; runtime additions synchronize automatically. Remote kind 5 queries belong to independent discovery, while locally pending withdrawals remain durable. See [command lifecycle and upgrade behavior](docs/NIP-CD.md).

## Optional inbound policy and processing timing

```ts
import { Bot, allowlist, requestTiming } from 'chirli';

const bot = new Bot({ signer, inboundPolicy: allowlist(trustedIdentityPubkeys) });
bot.use(requestTiming({ onTiming: metric => { console.info(metric); } }));
bot.command({ command: 'ping', scopes: ['kind:14'] }, async ctx => { await ctx.reply('pong'); });
await bot.start(); // Command declarations remain automatic.
```

`inboundPolicy` runs after identity verification but before incoming history, peer evidence, observers or business callbacks. `allowlist([])` denies every external sender; supplied keys are snapshotted and must be lowercase hex identity keys. Existing `allowlist:[...]` options remain supported; configuring both requires both to allow. An inbound policy is not ordinary `bot.use()` middleware, which runs after receipt persistence. See [access policy](docs/ACCESS.md).

`requestTiming({onTiming})` is optional ordinary middleware. Its observer receives only `{durationMs,outcome:'success'|'failure'}` for the downstream processing chain. It never reads message context or error details, does not log by default and cannot let observer failures change processing. It excludes receipt/decryption, queue waiting and session commit after the chain; no command route name is inferred from text. See [API](docs/API.md).

## Public input and shared context

Register one explicitly scoped command for DMs, notes and comments. Public reads require `publicInbox: {relays: [...]}`; they never use implicit default relays. `ctx.input` contains the authenticated input, `ctx.reply()` chooses encrypted DM or public kind 1111, and `await ctx.thread({limit:30})` lazily loads prior context. Public context/session storage never reads private conversations.

```ts
const bot = new Bot({signer, publicInbox:{relays:publicInboxRelays}});
bot.command({command:'ping',scopes:['kind:14','kind:1','kind:1111']}, async ctx => {
  await ctx.reply('pong');
});
await bot.start();
```

Run `npm run example:public` for an offline three-kind demo and deterministic application-owned `/summarize` mock. See [targeting, replies, thread bounds and migration](docs/PUBLIC.md).

For application-owned background work, retain `ctx.input.event` and later call `await bot.thread(event,{limit:30})` and `await bot.reply(event,text)`. Both preserve private/public routing and reuse handler semantics. DM authentication requires the same account's retained incoming record; a public target requires the complete signed event. See [delayed calls and trust requirements](docs/API.md#replies-and-context-after-a-handler), or run `npm run example:async-reply` entirely offline.

Command `args` accepts a Zod 4 `z.object(...)` directly. The schema both generates NIP-CD metadata and validates decoded input; handler-only `ctx.args` and the second handler argument share the inferred valid result. Use middleware or `bot.catch` for centralized `InvalidArgsError` handling; no automatic error reply or retry is added. See [schema support and authorization boundaries](docs/API.md#zod-command-arguments).
