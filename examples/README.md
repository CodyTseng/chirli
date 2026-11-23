# Examples and walkthroughs

Choose the path that matches what you want to do:

| Goal | Start here |
| --- | --- |
| Run a persistent bot you can message | [Live bots](live/README.md) |
| Learn the API without network connections | The offline demos below |
| Build an application with your own signer | [First bot tutorial](../docs/TUTORIAL.md) |
| Check SDK boundaries and configuration | [Public API](../docs/API.md) |

## Run the offline demos

From this checkout, using Node.js 24+:

```sh
npm ci --ignore-scripts
npm run build
npm run examples:smoke
```

The smoke suite runs **14 independent demos**. Each uses disposable accounts and a memory transport, asserts its result and exits. No public relays, real credentials or model providers are contacted.

The storage and command-restart demos use isolated temporary files and remove them afterward. The other demos use in-memory storage. Build once before running individual demos:

| Demo | Command | What it demonstrates |
| --- | --- | --- |
| [Commands](commands.ts) | `npm run example:commands` | Route to a command or a text handler |
| [History](history.ts) | `npm run example:history` | Durable `handle()` processing and local pagination |
| [Sessions](session.ts) | `npm run example:session` | Conversation state saved after successful processing |
| [AI adapter](ai-handler.ts) | `npm run example:ai-handler` | An application-owned mock processor |
| [Protocol modes](protocol-modes.ts) | `npm run example:protocol-modes` | The same handler with NIP-17 and NIP-4E |
| [Signers](signers.ts) | `npm run example:signers` | A signer-only application boundary |
| [Typed commands](nipcd.ts) | `npm run example:nipcd` | Zod validation, authorization, publication and restart withdrawal |
| [Interoperability](interop.ts) | `npm run example:interop` | Exchange messages between protocol modes |
| [Key rotation](rotation.ts) | `npm run example:rotation` | Retained keys support delayed senders |
| [Custom storage](storage.ts) | `npm run example:storage` | Custom message history and internal session recovery |
| [Allowlist](allowlist.ts) | `npm run example:allowlist` | Reject senders before persistence and handlers |
| [Device key sync](key-sync.ts) | `npm run example:key-sync` | Two devices sharing an account synchronize split keys |

Compiled demos live in `dist/examples/` and import the public `chirli` export. You can also run them with Node, for example `node dist/examples/commands.js`.

## Suggested learning order

### 1. Commands and middleware

Start with [commands.ts](commands.ts). Its output is:

```text
/help -> Commands: /help, /ping, /roll <1..20>
/ping -> pong
hello -> Text handler received: hello
/roll 6 -> Rolled N on a 6-sided die.
/roll -> Usage: /roll <1..20>
/roll invalid -> Usage: /roll <1..20>
/roll 21 -> Usage: /roll <1..20>
```

The rolled N is a random integer in 1..6; the demo asserts its bounds.

The Bot dispatches to a matching command or its text handler. Register shared steps with `use()` and await `next()` to continue toward routing.

### 2. Processing and local history

[history.ts](history.ts) registers `bot.handle()`. The fallback runs when the message reaches routing and has no matching command. Use `observe()` to monitor receipts independently.

The current incoming message is already persisted when its handler runs. Exclude it by ID when selecting earlier context. History also contains outgoing replies; select direction explicitly.

Follow `nextCursor` to read older local pages. `coverage: 'local-only'` and `complete: false` describe local coverage, not a complete relay archive.

### 3. Sessions and restart

[session.ts](session.ts) walks through `/start`, a name, and a visit counter. Its in-memory state disappears when the demo exits.

Use [storage.ts](storage.ts) to see an actual close/reopen cycle. In an application, retain the same signer credentials, database and any storage key across restarts.

### 4. Typed public commands

[nipcd.ts](nipcd.ts) adds `/sum`, checks the caller, restarts with a reduced registry, adds a command at runtime, then restarts with an empty registry. The disposable identity and relay remain the same.

All command definitions are public on configured write relays. The demo reports:

```text
public commands across restart 2 -> 1 -> 2 -> 0
```

User-installed kind `10992` lists are untouched. See [command lifecycle](../docs/NIP-CD.md).

### 5. Application adapters

[ai-handler.ts](ai-handler.ts) injects a deterministic mock `TextProcessor`. It makes no real model calls and selects its input explicitly. Replace that application interface with your provider; SDK core does not change.

[signers.ts](signers.ts) uses local disposable nsec signers. For actual bunker credentials and authorization, see [signer setup](../docs/SIGNERS.md). Loopback tests use a mock bunker; the offline demo does not contact one.

## Additional examples

- [local.ts](local.ts), run with `npm run example:local`, exchanges messages through two local WebSocket relays. It requires socket binding and is separate from the 12-demo offline suite.
- [handlers.ts](handlers.ts) exports reusable handler setup functions. It is a collection of snippets, not an executable demo.
- [_json-storage.ts](_json-storage.ts) implements message records and processing state with `insert`, `query` and `updateState`. Sessions, outbox and keys stay in the internal SQLite database. It rewrites the whole file and is intended as a small-workload history example, not an indexed production database.

## Ownership and boundaries

The application closes Bot before its injected signer, transport or storage. Bot closes resources it creates internally. Closing a Bot detaches that Bot and leaves the shared Bot running.

[_support.ts](_support.ts) contains a simplified `MemoryRelay` and a sequential request/reply harness. It exercises real SDK signing, encryption, verification and processing, but does not model network failures, AUTH, relay replacement or reconnect. Each scripted request expects one reply.

Demos deliberately print their own scripted text. The SDK has no default message logger. These walkthroughs do not establish public-relay availability, physical-device interoperability or production readiness; see [interoperability](../docs/INTEROPERABILITY.md) and [security boundaries](../SECURITY.md).

Run `npm run example:allowlist` after building to try `inboundPolicy: allowlist([...])` with disposable keys and an in-memory transport. The example uses `bot.use(requestTiming({onTiming}))` to show that only accepted messages reach processing middleware. [Allowlist example](allowlist.ts)

## Public notes, comments and DMs

`npm run example:public` runs `examples/public.ts` entirely in memory with disposable identities. One `/ping` handler receives kind 14, 1 and 1111; output identifies encrypted versus public replies. `/summarize` uses an explicitly marked deterministic mock over prior ancestors. No model is contacted. Expected output ends with `kind 1111 /summarize -> application-owned mock, ancestors only`.

All command examples now use `{command, scopes}`; no default command scope or string shorthand remains. Public inbox configuration must list explicit URLs. See [public input](../docs/PUBLIC.md).

## Delayed work with original events

`npm run example:async-reply` runs `examples/async-reply.ts` with fresh disposable identities and memory relay only. An application-owned list saves `ctx.input.event`; after all handlers finish, a worker calls `bot.thread(event)` and `bot.reply(event,...)` for kind 14, 1 and 1111. Expected output contains three `After handler:` lines distinguishing encrypted DM and public kind 1111 replies. It calls no model or external service. A durable application queue must protect plaintext DM events and reopen the same authenticated account store.
