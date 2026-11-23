# Architecture

Chirli is a Node.js SDK for Nostr private text and explicitly scoped public commands. Applications own authorization, business effects, signer credentials and deployment. `src/index.ts` is the public entry point.

## Module responsibilities

| Layer | Modules | Responsibility |
| --- | --- | --- |
| Application | `examples/live/`, application code | Configuration, ready output, signals, provider adapters and periodic retries |
| Bot | `bot.ts`, `bot-handlers.ts` | Public lifecycle and messaging API, middleware, commands and sessions |
| Internal client | `client.ts` | Lifecycle, verified intake, conversation queues and coordination of lower layers |
| Commands | `nipcd.ts`, `commands.ts`, `command-discovery.ts` | Pure schemas/parsing, durable public reconciliation, and read-only discovery |
| Signers | `signer.ts`, `signers/`, `signers.ts` | Account capabilities and the internal protocol bridge |
| Protocol | `protocol.ts`, `modes.ts`, `nip4e-compat.ts` | Envelope verification, mode policy and authenticated peer-key evidence |
| Keys and metadata | `keys.ts`, `key-sync.ts`, `metadata.ts`, `messaging-metadata.ts`, `announcements.ts` | Key custody, device sync, verified metadata views and relay-list publication |
| Network | `relay-pool.ts`, `relay.ts`, `inbox.ts` | Physical connections, bounded operations, reconnect demand and history recovery |
| Persistence | `store.ts`, `storage.ts`, `storage-sqlite.ts` | Internal SQLite state and replaceable message/state persistence (`message-storage*.ts`) |

Bot owns one internal client. Each queued message runs middleware before routing to a matching command or to the optional text fallback. AI/model adapters belong to applications.

Command execution, publication and discovery are independent: discovery never installs a handler or publishes metadata. `command()` validates explicitly scoped object definitions before registering them in the same command pipeline.

## Construction and ownership

`new Bot({ signer })` accepts configuration and handlers synchronously. Startup resolves the public key and opens persistence. The Bot closes its built-in resources. Injected signers, transports and message storage remain application-owned.

## Startup and shutdown

1. Construct the Bot and register handlers and the full command set.
2. `start()` publishes key/relay metadata and reconciles the public command catalog, including an empty set.
3. Startup restores unfinished work, opens inbox subscriptions and retries the outbox. Every write relay must accept command reconciliation. One ready DM replica can serve the Bot while other DM replicas reconnect.
4. The live runner prints the identity and QR after startup succeeds.

Stop cancels subscription/reconnect demand and drains intake, handlers and SDK work. Close then releases owned resources. Application timers are stopped and awaited before their injected dependencies are closed. Handler calls to self-draining `idle`, `retryInbox`, `stop` or `close` reject; `requestStop()` requests shutdown without waiting on the caller.

## Incoming messages

Giftwrap and seal signatures, rumor hash/author, times and one-to-one routing are verified before persistence. Sender allowlist checks follow authentication and precede peer evidence, history insertion and dispatch.

A temporary rumor handoff and its key evidence commit atomically in internal SQLite before insertion into MessageStorage. The handoff is removed after durable insertion. `(account/mode, rumor ID)` deduplicates wrappers across relays and restarts.

- New incoming live messages enter `pending → processing → done`.
- A handler failure records `failed`; retry or restart can run it again.
- History and outgoing self copies become `done` without business dispatch.
- Conversation queues are serial; different conversations can proceed concurrently.

Receipt observers receive detached copies and do not control durable success. Multiple durable handlers form one processing group, so a later failure can repeat earlier effects. Session saves and arbitrary external effects are not one transaction; applications need their own idempotency.

## Outgoing messages

A reply references its parent rumor ID through an `e` tag inside the encrypted kind-14 event. Outgoing kind-7 reactions use the same private envelope and durable outbox. Text history and incoming dispatch accept kind 14. Recipient metadata is resolved before queuing. A temporary outgoing message handoff and exact signed envelopes commit together before publication; the message is then inserted into MessageStorage before normal send publication. Each recipient/self envelope requires at least one relay ACK. Failure keeps the bundle pending; retries reuse its IDs and ciphertext.

Relay acceptance does not establish delivery or reading. A new `send()` call creates a new logical message.

## Public commands

Each command has one kind `31992` coordinate derived from its local trigger; user-installed kind `10992` lists are untouched. Startup uses broad author-scoped definition snapshots without querying withdrawals; local pending kind 5 operations remain durable. Independent discovery verifies author-scoped definitions and withdrawals without a membership list.

Reconciliation queries each write relay separately, combines signed definitions/deletions with durable retry state, publishes additions/updates/withdrawals, and commits the complete catalog last. Known truncated queries fail rather than becoming deletion evidence. Every write destination must ACK before advancing.

Handler registrations and standalone metadata registrations hold independent references. Public metadata cannot change an attached handler's schema. Revocation removes the coordinate globally and invalidates old handler registrations.

Background announcement retry only reconciles dirty/pending command state. Startup and explicit `syncCommands()` still verify the full remote view. Read-only discovery reports a bounded relay snapshot, not global completeness.

## Protocol and keys

Default NIP-17 uses account-key NIP-44. Explicit NIP-4E mode keeps local split messaging keys while retaining account-key crypto for standard peers. Both modes accept supported standard and extension envelopes.

The account keyring is shared across mode scopes; messages, sessions, checkpoints and business work are scoped separately. Rotation persists the candidate and signed declaration before publication, activates after ACK/durable commit, and retains configured retired keys. Unknown advertised own keys cannot be silently overwritten.

A remote signer sees NIP-44 plaintext it processes. Operational signer failures remain retryable and prevent recovery checkpoints from advancing.

## Network and storage limits

One nostr-tools AbstractRelay per configured relay URL shares operations and AUTH; the Node socket adapter preserves exact paths and queries. Connect/EOSE/ACK/AUTH budgets are separate. Inbox owns durable reconnect demand and bounded overlap paging; the physical pool does not independently reconnect.

The NIP-46 signer uses an `AbstractSimplePool` adapter backed by its own `WebSocketTransport` instance. It shares the physical relay implementation with Bot traffic and reopens missing response subscriptions on demand. Closing the signer releases its relay connections, including connections to relays returned by `switch_relays`.

Recovered frames remain history. Saturated timestamp boundaries, page limits or failed reads leave coverage incomplete. No full archive or durable undecryptable-envelope quarantine is promised.

Store applies AES-GCM when a storage key is supplied, otherwise tagged plaintext. MessageStorage owns message records, duplicate detection and processing state. Its default sqliteMessageStorage uses indexed native queries. Internal SQLite owns outbox, keys, metadata and temporary cross-store handoffs, and accepts only a database path. Failed handoffs are replayed without replacing existing message state; internal message copies are removed after successful insertion. The SDK supports one active Client/process per account database. Distributed claims, admission/backpressure limits, pruning, forward secrecy and exactly-once external effects remain outside its scope.

## References and validation

Protocol reference: PsstPsst checkout `5e6940fe6daa130d4143bf457078c3768202cc10`. Relay reference: `d7873d66fd1c0e6dbb0aaa2f55475944c4ba57ce`. Committed fixtures record upstream provenance; generation scripts use disposable keys without loading application state.

Tests cover protocol verification, persistence/restart, command reconciliation, lifecycle concurrency and application readiness. Offline examples use memory transport; loopback tests require socket binding. Optional `PSST_RELAY_BIN` and `PSST_SOURCE` tests exercise external reference implementations when configured. These checks do not establish physical-device interoperability or an independent security audit.

See [API](docs/API.md), [command lifecycle](docs/NIP-CD.md), [key custody](docs/KEYS.md), [storage](docs/STORAGE.md), [recovery](docs/RECOVERY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Optional official policy and timing

`inbound-policy.ts` supplies the pure snapshot identity allowlist and InboundPolicy type. Client keeps its existing verified-intake and pending-work gates, applying the legacy restriction and optional inboundPolicy through the same implementation. Only the authenticated sender string crosses that hook. `request-timing.ts` supplies ordinary downstream middleware with a frozen duration/outcome metric, no context inspection and isolated nonblocking observers. Bot dispatch, sessions and automatic command reconciliation remain unchanged.

## Public input isolation

`public-inbox.ts` owns a separate verified kind 1/1111 subscription and durable public journal in internal account/mode storage. Only matching, unambiguously targeted registered commands enter business middleware. Admission checks signatures, source relay, author policy, structure, scope and invocation before persistence, and repeats policy before dispatch. Per-root queues and `public:` session keys never use DM message rows or peer sessions. `bot.observe`, message history/state/listing remain DM-only.

`public-thread.ts` parses legacy/NIP-22 topology, batches a root across legacy `#e` and modern `#E` (plus coordinate variants), and follows only the trigger ancestor branch under one deadline and size/lookup/depth limits. Public replies are signed kind 1111 events with a durable outbox, configured write/source destinations, and exact-ID retries. Transport queries have no cancellation API; a timed-out resolver returns while already acquired transport queries settle under transport budgets. Stop drains active processing and cancels subscription/reconnect demand.

## Event-based delayed actions

Client.reply/thread resolve a detached original input event into either an exact account-bound authenticated incoming DM record or a reverified public target. Bot exposes that path directly, and handler methods capture independent anchor snapshots and use the same execution. Public target lookup retains no new event-body index: a signed supplied event is sufficient, while the existing journal may supply known source provenance. Private thread reads retain the original record cutoff. No job queue or idempotency layer is introduced.

Command args use a single Zod 4 object. command-schema.ts projects its supported positional subset into unchanged wire CommandArgument metadata at registration. Entry policy and ordinary middleware precede decoding/validation. Only recognized target/scope matches can raise a framework terminal InvalidArgsError. Such errors are consumed after centralized observation; operational/business errors preserve retry behavior. Args-dependent authorization suppresses invalid-input response hooks; valid authorization and command-only context use Zod's parsed output.
