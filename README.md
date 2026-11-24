# Chirli

A TypeScript SDK for Nostr bots with private messages and file attachments, public note/comment commands, middleware and persistent sessions.

**Node.js 24+ · ESM · Experimental**

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

Once the first release is available on npm, install Chirli in your project.

```sh
npm install chirli
```

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

const signer = bunkerSigner(bunkerUri, { clientSecret: bunkerClientKeyFromYourSecretManager });
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

Handlers run serially within a conversation and concurrently across conversations. An eligible authenticated input is claimed durably by its canonical ID before middleware. A failure is reported but does not cause a second attempt, even after reconnect or restart. Live and recovered incoming DMs created since first activation follow the same processing path. Eligible outgoing self copies can still populate history. [Event processing flow](docs/API.md#event-processing-flow)

`observe(observer)` monitors newly admitted DMs saved to local conversation history; it does not control processing. Register handlers before `start()`.

To reference the current DM in a reply, pass `ctx.input.id` as `replyTo`:

```ts
await ctx.reply('Got it', { replyTo: ctx.input.id });
```

Use `bot.getMessage(id)` for local private-message lookup, or `ctx.thread()` to load preceding context. To react to the current input, call `ctx.react('👍')`.

### Inspect history and retry delivery

```ts
const result = await bot.send(peerPubkey, 'Hello');
// result.status: 'relay-accepted' | 'pending'

const page = bot.dmHistory(peerPubkey, { limit: 20 });
const state = bot.getMessageState(messageId);

await bot.flushOutbox();
```

Rumor IDs prevent duplicate live attempts across relays and restarts. If a process exits after claiming a message, its callback may never run or may stop partway through. Use an application-owned job if you need durable business retries. Outbox retries reuse the original signed envelopes. Relay acceptance does not confirm delivery or reading.

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

Definitions and scopes describe command availability. Use `bot.use(allowlist(pubkeys))` to authorize senders, or an `authorize` callback for an individual typed command. [Command lifecycle](docs/NIP-CD.md) · [Sender authorization](docs/ACCESS.md)

## Configuration

| Option | Purpose |
| --- | --- |
| `signer` | Required account signing and NIP-44 capabilities |
| `database` | SQLite path; defaults to `psstpsst.sqlite` |
| `messageStorage` | Message backend; defaults to `sqliteMessageStorage` |
| `storageKey` | Optional 32-byte key for local payload encryption |
| `relays` | Common list for each omitted relay role |
| `dmRelays` | Receive and deliver private messages |
| `readRelays` | Query public metadata |
| `writeRelays` | Publish public commands and account metadata |
| `discoveryRelays` | Extra targets for public account announcements |
| `mode` | `nip17` by default; `nip4e` enables separate messaging keys |

Use a fresh database for this pre-release storage format. Point `database` to a new path rather than replacing existing files. For subsequent restarts on this format, preserve the signer credentials, database and any storage key. `messageStorage` holds private conversation history and its diagnostic states; it defaults to `sqliteMessageStorage` in the configured database. Supply `sqliteMessageStorage('./messages.sqlite')` or implement `insert`, `query` and `updateState` to use another history backend. ID claims, outbox, keys and other internal data use `database`. Custom `Transport` implementations are also supported.

### Resource lifecycle

The component that creates a resource closes it:

- Bot closes its built-in transport and storage.
- Your application closes injected signers, transports and storage adapters.
- `bot.stop()` drains handlers and keeps the Bot reusable. `bot.close()` also releases its resources.

Close Bot before its injected resources. Call stop/close outside message handlers; use `bot.requestStop()` when a handler needs to request shutdown.

### Protocol modes and recovery

Default NIP-17 uses account-key encryption. Explicit `mode: 'nip4e'` generates or restores separate messaging keys for extension peers. Both modes accept supported standard NIP-17 and NIP-4E messages.

Relay connections are pooled and reconnect independently. Recovery uses bounded overlap paging. On first startup the Bot saves its DM activation time. Older DMs are ignored; new DMs found after downtime enter the same middleware and handlers as live DMs, at most once.

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

Chirli supports one-to-one private text, reply references, private and public reactions, and explicitly scoped kind 1/1111 public commands. See [public inputs and threads](docs/PUBLIC.md). Groups, receiving or downloading attachments, full archive recovery and exactly-once external effects are outside its scope. One active Bot/process per account database is supported. Public relays, external signer products and production deployments require separate validation.

Bot command identifiers come from their command names; custom `id` parameters are rejected. Renaming a command removes the old coordinate and adds the new one. Startup compares one broad author-scoped kind 31992 scan per write relay with the complete local registry; runtime additions synchronize automatically. Remote kind 5 queries belong to independent discovery, while locally pending withdrawals remain durable. See [command lifecycle and upgrade behavior](docs/NIP-CD.md).

## Optional access and timing middleware

```ts
import { Bot, allowlist, requestTiming } from 'chirli';

const bot = new Bot({ signer });
bot.use(allowlist(trustedIdentityPubkeys));
bot.use(requestTiming({ onTiming: metric => { console.info(metric); } }));
bot.command({ command: 'ping', scopes: ['kind:14'] }, async ctx => { await ctx.reply('pong'); });
await bot.start(); // Command declarations remain automatic.
```

`allowlist` snapshots the supplied lowercase hex identity keys. Register it first to block downstream middleware and handlers for nonmembers. `allowlist([])` blocks every external sender from routing, including eligible DMs discovered during recovery. Returning early does not undo the prior ID claim. [Sender authorization](docs/ACCESS.md)

`requestTiming({onTiming})` is optional ordinary middleware. Its observer receives only `{durationMs,outcome:'success'|'failure'}` for the downstream processing chain. It never reads message context or error details, does not log by default and cannot let observer failures change processing. It excludes receipt/decryption, queue waiting and session commit after the chain; no command route name is inferred from text. See [API](docs/API.md).

## Public input and shared context

Register one explicitly scoped command for DMs, notes and comments. Public reads require `publicInbox: {relays: [...]}`; they never use implicit default relays. `ctx.input` contains the authenticated input. `ctx.reply()` and `ctx.react()` preserve its private or public visibility, and `await ctx.thread({limit:30})` lazily loads prior context. Public context/session storage never reads private conversations.

```ts
const bot = new Bot({signer, publicInbox:{relays:publicInboxRelays}});
bot.command({command:'ping',scopes:['kind:14','kind:1','kind:1111']}, async ctx => {
  await ctx.reply('pong');
});
await bot.start();
```

Run `npm run example:public` for an offline three-kind demo and deterministic application-owned `/summarize` mock. See [targeting, replies and thread bounds](docs/PUBLIC.md).

For application-owned background work, retain `ctx.input.event` and pass it to `bot.thread(event,{limit:30})`, `bot.reply(event,text)` or `bot.react(event,'👍')`. These methods preserve private/public routing and reuse handler semantics. DM authentication requires the same account's retained incoming record; a public target requires the complete signed event. See [delayed calls and trust requirements](docs/API.md#replies-and-context-after-a-handler), or run `npm run example:async-reply` entirely offline.

Command `args` accepts a Zod 4 `z.object(...)` directly. The schema both generates NIP-CD metadata and validates decoded input; handler-only `ctx.args` and the second handler argument share the inferred valid result. Use middleware or `bot.catch` for centralized `InvalidArgsError` handling; no automatic error reply or retry is added. See [schema support and authorization boundaries](docs/API.md#zod-command-arguments).
