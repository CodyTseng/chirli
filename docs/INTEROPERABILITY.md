# NIP-17 and NIP-4E interoperability

Chirli receives both standard NIP-17 and the PsstPsst NIP-4E profile in either Bot mode. Choose the mode that determines how your Bot sends to extension-capable peers.

| Bot mode | Messaging key for extension peers |
| --- | --- |
| `nip17` (default) | The account identity key |
| `nip4e` | A separate key held in the local keyring |

## Key selection and envelopes

At startup, the Bot publishes its inbox relays (kind `10050`) and, when applicable, its messaging key (kind `10044`). It verifies peer declarations and can also learn a peer's messaging key from an authenticated incoming seal. See [relay routing](RELAYS.md) for discovery, fallback and caching.

- **Standard peer.** The Bot uses an empty-tag seal, a randomized seal timestamp and identity-key NIP-44, including when the Bot is in split-key mode.
- **Extension peer.** The Bot uses the first `n` seal tag and the message timestamp. Both encryption layers target the peer's verified messaging key.
- **Incoming messages.** The Bot can try the identity key and held split keys. It verifies the wrap, seal, message hash, author and one-to-one routing before exposing text.

Public giftwrap routing uses the recipient's stable identity key. Self copies use the Bot's own messaging profile. A standard-mode Bot can still decrypt messages for split keys it retained from an earlier configuration.

## Compatibility and key custody

`nip4eCompatibility: false` suppresses the identity-key `10044` announcement in NIP-17 mode. Both modes still receive both supported formats. Split mode announces its current split key.

A valid declaration or authenticated seal is evidence that a peer supports the extension. Metadata is limited to what the configured relays and local storage have observed. If another device publishes a conflicting key, use the [key migration procedure](KEYS.md#explicit-migration-and-upgrade).

Use a persistent database and protect its [keyring](KEYS.md#durable-custody-and-failure-recovery). Signing credentials remain in the [signer](SIGNERS.md). Neither profile provides forward secrecy.

## References and example

Chirli's extension behavior follows the [PsstPsst profile](https://psstpsst.chat/docs/private-messages/) and the [NIP-4E draft](https://github.com/nostr-protocol/nips/pull/1647). The standard envelope uses [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md), [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) and [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md).

Run `npm run example:interop` after building for an offline mixed-mode command and reply. The [contributor guide](../CONTRIBUTING.md) describes the optional interop fixtures and tests.
