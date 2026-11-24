# Contributing to Chirli

Chirli is a Nostr bot SDK for private messages and explicitly scoped public commands. Applications own message handling, context selection and external effects. The package name is `chirli`; `Bot` and its public interfaces are shared across protocol modes; `Client` is internal. Keep AI adapters in applications/examples, not SDK core.

## Local development

Use Node 24+ and npm. From this checkout:

```sh
npm ci --ignore-scripts
npm run check
```

`check` builds from a clean `dist/`, checks all TypeScript, runs tests, executes fourteen offline examples, and checks an actual npm tarball in an isolated consumer. Local WebSocket tests and the packaged loopback demo need permission to bind loopback sockets. No public relays, account keys, or paid APIs are required.

Use `npm run format` to apply Biome's default formatting and `npm run lint` to see its recommended lint warnings and errors. `npm run check:style` is the read-only CI style check; formatting differences and lint errors fail it. Biome covers JS/TS under `src`, `test`, `examples` and `scripts`, excluding fixtures. TypeScript still runs separately.

`npm test` uses temporary identities/databases. Two optional tests require an externally built PsstPsst Go relay:

```sh
PSST_RELAY_BIN=/absolute/path/to/local-relay npm test
```

The optional `PSST_SOURCE=/path/to/psstpsst/src/services/crypto/nip17-gift-wrap.ts npm test` also exercises actual extracted software-envelope functions. If their environment variables are unset, these optional integrations are reported as skipped; the independent local WebSocket and protocol-helper tests still run. Do not silently substitute public-relay tests. GitHub Actions is configured for Node 24 on Linux and macOS; adding a workflow does not imply a remote run has passed.

## Scope and changes

- Preserve default identity-key NIP-17, explicit split-key opt-in and dual-protocol receive in both modes. Key rotation must persist candidate custody before publication and preserve legacy/retry identities. Concentrate differences in protocol strategies and envelope policies.
- Verify signatures, authors, IDs and recipients before persisting or exposing messages. Do not bypass verification caches by trusting a previously marked object.
- Deduplicate by rumor ID. Keep protocol receipt, business status and relay acceptance separate.
- Add focused regression tests for behavior changes, particularly concurrency, history/live boundaries, restart and mode isolation. Tests should exercise observable behavior rather than copy implementation details.
- Keep documentation, examples, comments and diagnostics in clear English. Follow existing TypeScript formatting; no formatter or linter is currently mandated.
- Never commit credentials, real account events, personal databases, or application plaintext. The committed protocol fixture uses disposable keys; keep its provenance and license notice.
- Keep changes focused. Explain what changed, why, tests run, compatibility and known limits in a contribution description. Do not claim delivery/read confirmation or exactly-once effects from relay ACKs.

See [API.md](docs/API.md), [signers](docs/SIGNERS.md), [recovery](docs/RECOVERY.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [examples/README.md](examples/README.md). Dependency changes must preserve a reproducible lockfile and update THIRD_PARTY_NOTICES.md when licenses or copied code change.

## Reports and licensing

For ordinary bugs, provide runtime versions, selected mode, a minimal reproduction with disposable keys, and expected and actual behavior. Keep private keys, storage keys, personal messages and relay credentials out of reports. [GitHub Issues](https://github.com/CodyTseng/chirli/issues)

Report potential vulnerabilities privately using the instructions in [SECURITY.md](SECURITY.md). Chirli is licensed under MIT and retains the upstream attributions in [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

NIP-CD is a draft integration. Retain stable command coordinates and signature/deletion handling. Commands are always public on configured write relays; Bot startup reconciles the complete local registry before dispatch. Keep kind 31992 definitions and kind 5 withdrawals distinct from standard user-installed list 10992. Bot coordinates are command-name derived; wire decoding retains external d values. Do not describe the SDK's private-DM scope mapping as standardized. See docs/NIP-CD.md.

Storage adapters implement the exported synchronous opaque-record contract; keep codec selection/crypto in the SDK facade; preserve AES-GCM with storageKey and tagged plaintext without it. Preserve exact bytes, scopes, detached reads and durable atomic writes. Reuse test/storage-contract.ts and include rotation, uncertain ACK, restart and rollback cases. Multi-relay changes must preserve partial-success availability, first-ready startup, independent historical catch-up and rumor-ID dedup. Use authenticated inner DM time and the persisted first activation for admission. Recovered eligible DMs follow the same at-most-once path as live delivery. See docs/STORAGE.md and docs/RELAYS.md.

Sender authorization is ordinary middleware over authenticated identity authors, never wrapper or split encryption keys. Preserve absent versus empty allowlist semantics; authenticate and atomically claim the ID before middleware, and do not rerun middleware for rejected, failed or previously claimed input. Verify independent private history and outgoing delivery retry. See [access middleware](docs/ACCESS.md).

Live examples are real long-running bot programs, not offline walkthroughs. Their tests must launch the real compiled entrypoints using only test-generated config/identities and loopback relays. Never load an operator .env.chirli or inherit CHIRLI credentials into child fixtures. Preserve initializer non-overwrite/0600 behavior, restart persistence, clean signals and sanitized logs. Package smoke only runs live --help, never configured public-relay programs.

Test zero-config defaults without contacting public relays: unit-check the PsstPsst default list, but override CHIRLI_RELAYS to loopback for live child processes. Generated test identities must use temporary databases/directories. Cover signer reuse, plaintext persistence, optional encrypted signer files and missing/wrong-key refusal; never regenerate an identity over existing/corrupt account state.

Public input changes must preserve explicit kind scopes/inbox relays, verified author/source gates, no history replay, ID deduplication, public/private state separation, kind 1111 root/parent references, and bounded ancestor-only resolution. Keep public URLs out of tests; use the loopback replica and memory tests in test/public.test.ts. New application processing belongs in handlers rather than SDK core.
