# Bots you can run and leave online

These programs connect to DM relays and keep listening until Ctrl+C/SIGTERM. No environment variables are required for a new bot:

```sh
npm ci --ignore-scripts
npm run build
npm run bot:commands
```

`npm run example` starts the same commands bot. On first launch it generates a new identity and saves `.chirli/bot.sqlite.identity.json` with mode 0600. Later launches reuse it. After account metadata publication, command synchronization and inbox startup succeed, a single ready banner shows the public npub/hex pubkey and a scannable `nostr:npub…` QR code. QR output is limited to interactive terminals wide enough to display it; redirected logs retain the text address. Startup failure or cancellation does not print a ready banner or public identity. Private keys are never printed. Message that npub from another PsstPsst/NIP-17 account with `/ping`; the bot replies `pong` once ready. A usable sender 10050 is preferred; if missing, the bot falls back to its own DM relays. Verified incoming seal evidence supplies the encryption key even without 10044.

## Zero-configuration defaults

| Missing setting | Behavior |
| --- | --- |
| CHIRLI_NSEC and CHIRLI_BUNKER | Generate/reuse the private identity file next to the database |
| CHIRLI_STORAGE_KEY | Plaintext local messages, sessions and split-key custody; no at-rest encryption |
| CHIRLI_RELAYS | PsstPsst's default DM relay list below |
| CHIRLI_DATABASE | .chirli/bot.sqlite |
| CHIRLI_MODE | Identity-key nip17; both receive protocols accepted |
| CHIRLI_ALLOWLIST | Accept all authenticated incoming identities; an explicitly empty value denies all |

Default relays, derived from PsstPsst's `src/lib/nostr/relay-url.ts` DEFAULT_DM_RELAYS:

```text
wss://relay.psstpsst.chat/
wss://nos.lol/
wss://relay.ditto.pub/
```

These are configuration defaults, not guarantees about operators or availability. Starting a live bot uses these public relays unless you override them. Automated tests use local relays instead. At least one replica must be healthy; partial discovery/ACK/readiness limits are documented in [RELAYS.md](../../docs/RELAYS.md).

Plaintext **local storage** does not change DM encryption: wire messages still use NIP-44/seal/giftwrap encryption and verification. Without a storageKey, adapters/local files can read or alter stored message/session/keyring values. Treat the database, identity file and backups as private. New directories use 0700 and files 0600; this is not a hardware vault.

## Choose a bot

Run one profile at a time per account/database:

| Command | What to send |
| --- | --- |
| npm run bot:commands | /help, /ping, /whoami |
| npm run bot:echo | Any text; text handler, first 2000 characters echoed |
| npm run bot:session | /start, your name, then messages; visits persist across restarts |
| npm run bot:notes | /remember apples, /notes, /help; latest 10 local notes |

Session example: `/start` -> `What is your name?`, `Ada` -> `Nice to meet you, Ada.`, `hello` -> `Hello Ada, visit 1.`. Restart and send another message to get visit 2. Notes are bounded local-history queries, including valid recovered `/remember` messages, not a complete remote archive.

The finite offline walkthroughs remain in the parent folder. `npm run examples:smoke` executes those without network access; `npm run example:local` uses two loopback relays.

## Optional configuration

Node loads `.env.chirli` when present. Existing shell environment variables take precedence. For example:

```dotenv
CHIRLI_RELAYS=wss://your-relay.example,wss://another-relay.example
CHIRLI_ALLOWLIST=your-identity-hex
```

Use actual relay URLs/identity hex values. Do not add placeholders for unused settings. Blank nsec/storageKey/relays are treated as omitted; malformed nonempty values fail configuration. [config.example](config.example) lists the options as comments only.

To supply your own identity, set either CHIRLI_NSEC or CHIRLI_BUNKER, never both. An absent nsec does not replace an explicitly configured bunker signer. An explicit allowlist uses lowercase identity hex pubkeys, not encryption keys/npubs. Empty CHIRLI_ALLOWLIST= denies every incoming external sender.

To enable at-rest encryption for a fresh database/identity file, provide an independent 64-hex CHIRLI_STORAGE_KEY. Automatic identity files use the same mode: encrypted with that key when supplied, otherwise plaintext. Preserve the same key across restarts. Existing encrypted data cannot be read without its original key, and plaintext data cannot silently become encrypted by adding a key. Migrate deliberately or choose a fresh database path; no automatic storage-mode conversion is supplied.

Preserve the database **and** its adjacent identity file. If a nonempty database exists without its generated identity file, startup refuses to invent a replacement account: restore that file or provide the original explicit signer. Invalid/corrupt identity files and wrong/missing encryption keys also fail without overwriting them. The SDK itself still requires an explicit Identity; automatic signer persistence is application-runner policy.

## Optional initializer and custom config path

You can still create a new explicit nsec/storageKey config:

```sh
npm run bot:init
# Optional overrides:
npm run bot:init -- --relays wss://YOUR_RELAY --allow YOUR_IDENTITY_HEX
```

Initializer generates a new nsec and storageKey into `.env.chirli` (0600), so this opt-in path enables encrypted storage. It never connects or overwrites an existing file. It does not import/migrate an existing account. No config/real credentials are committed. For another config path:

```sh
node --env-file=/absolute/path/to/.env.my-bot dist/examples/live/commands.js
```

## Bunker and separate keys

Set CHIRLI_BUNKER (and remove CHIRLI_NSEC) to use your remote signer. Optional CHIRLI_BUNKER_CLIENT_KEY preserves the NIP-46 client session. The signer must authorize identity signing and NIP-44 operations. Account identity is resolved independently of its transport key. Handle approval in the signer or configure permissions ahead of time. A signer response that requires opening an authorization URL fails.

For separate local encryption keys/rotation on a new account:

```dotenv
CHIRLI_MODE=nip4e
CHIRLI_ROTATION_DAYS=30
CHIRLI_LEGACY_KEYS=5
```

Optional CHIRLI_LEGACY_MAX_DAYS limits retirement age. Current/legacy split secrets persist with the selected storage mode. Existing key-policy changes require [explicit known-key migration](../../docs/KEYS.md); the runner never force-overwrites another declaration. Default nip17 never rotates the identity secret. Both modes receive both protocols.

## Runtime and troubleshooting

Startup announces 10044 key metadata, 10002 read/write roles, 10050 DM inboxes and registered public command definitions (31992). Commands publish only to write relays; keys publish to write and DM relays. Historical/self-copy messages do not run handlers. An application-owned timer retries pending announcements and exact pending outbox rows every 30 seconds (CHIRLI_OUTBOX_RETRY_MS, minimum 1000). This is not recipient delivery/read confirmation. SIGINT/SIGTERM drain current work and close storage/signer.

If no reply arrives, check the printed identity, allowlist, sender's 10050 inbox list, reachable relays and signer permissions. Only a public key is logged even when startup fails; secrets/message text are not logged. `node dist/examples/live/commands.js --help` describes usage without loading a config or connecting.

Tests start the real bot executables with generated credentials or no signer/storage key, local WebSocket relays and temporary files. They verify actual encrypted DM replies, restart identity/session/history, file permissions, storage-mode mismatch refusal and SIGTERM. Default public relays, real devices and production bunker flows are not tested by that suite. These are small usable applications, not an audited hosting/monitoring service.

### Background warning versus startup failure

A ready bot can legitimately log a failed replica, for example:

```text
[warning][background] RELAY_CONNECT_TIMEOUT relay=wss://unavailable.example operation=connect — background replica/recovery warning; other relays may remain usable.
```

This is not a claim that the entire bot failed. `Chirli commands ready` still means at least one replica initialized. The failed replica retries independently. You can override CHIRLI_RELAYS to the subset currently usable from your network, then restart without deleting identity/database files. Metadata lookup can wait for timeout bounds on unavailable replicas, so removing a persistently unreachable configured relay may reduce reply latency.

If startup exits, diagnostics use its failing phase, such as `[error][startup]`, and list each failed relay/code. HTTP rejection, AUTH rejection, connection timeout and EOSE timeout are separate. File permission/full-disk/SQLite codes are shown when available. Arbitrary handler errors still do not expose raw message/stack data. No automatic identity/database reset is a remedy for a connectivity warning.

## Separate relay roles

Optional `CHIRLI_DM_RELAYS`, `CHIRLI_READ_RELAYS`, `CHIRLI_WRITE_RELAYS` override each role independently (comma-separated URLs). `CHIRLI_RELAYS` is a common-list shorthand for omitted roles. With no settings, DM uses the three defaults above; read/write each use `wss://nos.lol/,wss://relay.primal.net/,wss://relay.ditto.pub/,wss://offchain.pub/`, matching PsstPsst's role fallback. Empty explicit read allows no read role; DM/write cannot be empty.

`bot:init` also accepts `--dm-relays`, `--read-relays`, `--write-relays` (or common `--relays`); it writes all three resolved roles without contacting them. Public command declarations include their full metadata/scopes. All Bot command definitions are public. Put unadvertised application behavior in ordinary middleware or Bot.handle instead of registering a command. Publication requires one ACK per distinct write/DM target set and may partially succeed; it is not atomic or proof of indexing/delivery. See [relay roles and retry](../../docs/RELAYS.md).

Established inbox connections recover transient disconnects silently for up to 30 seconds. A continuously unresolved network outage then emits one warning until recovery; repeated retries do not repeat it. Initial connection failures, disabled reconnect, authentication/subscription rejection, incomplete history, storage and handler failures remain observable. Stop cancels delayed warnings.

## Diagnose slow replies

```sh
npm run build
CHIRLI_TIMING=1 npm run bot:commands
```

Timings are off by default. The opt-in output includes each relay's metadata query and publication ACK duration/outcome, signer operation duration (including NIP-44 with bunker), and handler duration. It prints relay origins and event kinds, never URL paths/queries, event IDs, authors, contents, encryption inputs or raw error text. Example format (illustrative values):

```text
[timing] query relay=wss://relay.example kinds=10044,10050 durationMs=5001 outcome=error code=RELAY_EOSE_TIMEOUT
[timing] signer operation=nip44Encrypt durationMs=3 outcome=ok
[timing] publish relay=wss://relay.example kinds=1059 durationMs=180 outcome=ok
[timing] handler durationMs=5400 outcome=ok
```

Query kind 10044 is the own-key conflict check; 10050 is the bot's inbox lookup; 10044,10050 is peer key/inbox discovery. Initial announcements and peer refreshes also perform queries. Repeated query durations near the configured phase deadline (normally 5000 ms for connection or 25000 ms for EOSE) can identify a timeout; publication timings measure ACK, not recipient delivery. Handler timing starts after authenticated intake/storage and includes handler-owned reply/network work; it excludes sender-side delivery and per-conversation queue wait. Signer decrypt timings can reveal work before handler dispatch, including remote signer delays. These are overlapping measurements, not a set of durations to add together. No inbound/crypto validation is bypassed to collect them.

Running clients now read own 10044/10050 from verified subscriptions and reuse an in-memory peer cache, so a warm reply makes no metadata queries. Cold/forced lookups still open WebSockets and wait for bounded replica results. A newer verified seal key takes priority over an older cached announcement. Missing peer 10050 uses own DM fallback. See [cache policy](../../docs/RELAYS.md#own-metadata-and-peer-cache).

Without an override, the live transport uses separate connection (5000 ms), EOSE (25000 ms), ACK (5000 ms) and AUTH (8000 ms) budgets. `CHIRLI_RELAY_TIMEOUT_MS` optionally overrides all four budgets together (range 100..120000). Connections and AUTH are shared per relay, with 30-second idle retention and heartbeat detection. A shorter deadline can discard a usable slow/authenticated relay and cause missing metadata or pending sends. Prefer diagnosing and correcting the configured relay sets first. Both read/write and DM URLs participate in metadata lookup; changing only DM does not remove a slow read/write URL. `CHIRLI_RELAYS` can set a common operator-chosen list. Do not delete identity/storage to troubleshoot latency.

## Automatic same-identity key sync

In CHIRLI_MODE=nip4e, a missing advertised separated key can be requested from another same-identity device. Chirli automatically answers authenticated recent same-identity requests for held separated keys; identity private keys are never exported. Set CHIRLI_KEY_SYNC=0 to disable requests/responses; CHIRLI_KEY_SYNC_TIMEOUT_MS defaults to 30000. Automatic authorization relies on the account signature, without a human pairing-code prompt. A PsstPsst peer device may still require approval in its UI. See [key-sync security and custody](../../docs/KEYS.md#automatic-same-identity-key-synchronization).

## Adapting the examples

Start with the [first bot tutorial](../../docs/TUTORIAL.md). Command handlers stay in the profile entrypoints; credentials, startup readiness, retries and signals stay in [runtime.ts](runtime.ts). The notes profile extracts its reusable behavior into [notes-handler.ts](notes-handler.ts), so it can be tested with MemoryRelay without launching the CLI or opening sockets.
