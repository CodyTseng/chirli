# Third-party notices

The existing package metadata declares MIT and the complete inherited LICENSE is retained unchanged. Release maintainers must confirm the licensing and authorship decision for Chirli-authored work before public release; no new license approval is implied here.

PsstPsst protocol behavior and compatibility fixture generation are derived from the MIT-licensed PsstPsst project by Cody Tseng. Its complete original license, including the Expo attribution, is retained in LICENSE. The fixture generator extracts unchanged envelope functions from an explicitly supplied upstream source file; that temporary source is removed after fixture generation. No application account key material is included. The fixture contains only randomly generated disposable encryption keys.

References inspected (read-only):
- PsstPsst `docs/protocols/nip4e.md`, `docs/protocols/nip17-extensions.md`
- `src/services/crypto/nip17-gift-wrap.ts` and its tests
- `src/services/dm/observed-peer-key.service.ts`, `peer-encryption-key.service.ts`, and receive logic in `dm.service.ts`
- PsstPsst relay `docs/filters.md`, `README.md`, and executable entry point. Relay software is built externally for optional interoperability testing, not copied or distributed here.

Runtime dependencies: nostr-tools 2.26.0 (Unlicense), ws (MIT). Development dependencies: TypeScript (Apache-2.0), tsx (MIT), @types/node and @types/ws (MIT); transitive dependencies retain their own licenses in the installed packages. package-lock.json records exact versions. No grammY implementation was copied; the bot API is an original minimal middleware/command layer inspired by the familiar framework model.

The default standard mode follows the official nostr-protocol NIP-17, NIP-59 and NIP-44 specifications (checked 2026-11-15). Its tests use the installed Unlicense-licensed nostr-tools NIP-17 helpers as an independent wire-format reference. No additional implementation was copied from those specifications or another bot framework.


## License verification for this checkout

Direct dependency/license metadata and license files were inspected locally on 2026-11-15: nostr-tools 2.26.0 uses Unlicense; ws 8.22.0 uses MIT. The earlier notice calling nostr-tools MIT was incorrect and has been corrected. TypeScript 5.9.3 uses Apache-2.0; tsx 4.23.15, @types/node 24.19.2 and @types/ws 8.18.2 use MIT. The lockfile records the exact versions and transitive license metadata; installed dependency directories retain their original license texts.

Dependencies are not bundled into the Chirli tarball. Compiled SDK/examples are original project code; the local relay fixture is maintained within this project. The upstream PsstPsst source extraction generator and disposable-key compatibility fixture remain development-only and are excluded from the npm artifact. No source code was copied from grammY or another bot framework. Do not remove upstream notices if redistributing derived fixtures or regenerated source.


The headless reconnect/pager and signer adapters were informed by additional read-only MIT PsstPsst references: `src/services/relay/managed-relay-pool.ts`, `src/services/dm/gift-wrap-pager.ts`, reconnect recovery in `dm.service.ts`, `src/services/signer/nsec-signer.ts`, `nip46-signer.ts`, and `nip46-timeout.ts`. This project adapts their lifecycle concepts rather than importing application/platform code. Applicable original MIT notices remain intact. Bunker wire transport is provided by installed nostr-tools 2.26.0 (Unlicense); the SDK's adapter and local mock RPC fixture are original code. The standard NIP-46 specification was also checked; no real bunker credentials or account key material were read.

Draft NIP-CD support was implemented against the official nostr-protocol NIP-CD, NIP-01 addressable-event and NIP-09 deletion specifications checked 2026-11-15. No third-party command framework implementation was copied. The SDK-specific DM projection and parsing/discovery boundaries are documented in docs/NIP-CD.md.

Identity-key interoperability additionally references PsstPsst's native iOS/Android account decrypt paths (which require the first `n` seal tag), its current 10044 declaration handling, and the open NIP-4E proposal (nostr-protocol/nips PR 1647, `per-device-keys/4e.md`). The unique temporary extraction helper exercises unchanged MIT software-envelope functions solely for optional testing; no app runtime, vault or account data is loaded. A committed disposable-key identity-recipient fixture retains source SHA-256 provenance. No reference checkout was modified.

Configurable key rotation additionally references read-only PsstPsst `src/services/dm/encryption-key-rotation.service.ts`, `encryption-key-rotation-prefs.ts`, and native iOS/Android messaging-key vault retention (ten total records). Chirli implements its own encrypted Node SQLite custody and pending-ACK state machine with an explicit configurable retired-key policy; no native vault code, stored accounts or credentials were copied. Existing MIT notices are retained.

Incoming allowlist identity extraction was checked against the read-only PsstPsst software envelope identity-binding checks (seal author equals verified rumor author). Chirli's policy, pending-work handling and tests are original SDK code; no application allowlist/authorization implementation or account data was imported.

The default DM relay URL list is derived from read-only PsstPsst src/lib/nostr/relay-url.ts DEFAULT_DM_RELAYS on 2026-11-15, with nip17.com intentionally removed by Chirli configuration policy on 2026-11-16. Chirli does not import that application module or test/publish against those public endpoints. Existing MIT attribution is retained.

Read/write relay defaults and publication routing were additionally checked against read-only PsstPsst `src/services/relay/relay-list.service.ts`, `relay-router.ts`, and `src/lib/nostr/relay-url.ts` DISCOVERY_RELAYS. Chirli uses PsstPsst's read/write fallback URLs and independently implements SDK role routing/publication. NIP-65 kind 10002 tags follow the official nostr-protocol/nips specification. Existing MIT source attribution is retained; no account configuration or application module was imported.

Peer caching/refresh and automatic encrypted key transfer additionally reference read-only MIT PsstPsst `src/services/dm/peer-encryption-key.service.ts`, `observed-peer-key.service.ts`, `encryption-key.service.ts`, `key-sync-session.ts`, `src/services/relay/relay-list.service.ts`, and its NIP-4E protocol profile. Chirli independently implements own-account live subscriptions, instance-local bounded peer caching and headless same-identity signature authorization. The source app's UI approval requirement is intentionally not copied; Chirli documents its automatic policy and disable option. Existing MIT notices remain unchanged.

Terminal QR output uses the MIT-licensed `qrcode-generator` npm dependency by Kazuhiko Arase. It is used through its package API, without copying source into Chirli. Its upstream license is included in the dependency.

## Jumble structural reference

Public kind 1/1111 root/parent parsing, mixed-thread batching and relay-routing design were informed by read-only review of Jumble (`src/lib/draft-event.ts`, `src/lib/event-core.ts`, `src/services/thread.service.ts`, `src/services/client.service.ts`), MIT License, Copyright (c) 2025 Cody Tseng. Chirli's bounded headless resolver and isolated public journal were implemented locally; no Jumble runtime or dependency is bundled. The project's existing MIT license text is retained. Protocol references are NIP-22 and the NIP-CD draft.
