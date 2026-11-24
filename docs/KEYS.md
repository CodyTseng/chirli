# Messaging keys, rotation and migration

Chirli uses the account identity key in `nip17` mode by default. Set `mode: 'nip4e'` to use a separate messaging key. Both modes can receive both supported envelope formats. See [interoperability](INTEROPERABILITY.md) for key selection on the wire.

## Configuration and lifecycle

```ts
const day = 24 * 60 * 60 * 1000;

const bot = new Bot({
  signer,
  mode: "nip4e",
  database: "./chirli.sqlite",
  storageKey,
  keyRotation: {
    intervalMs: 30 * day,
    retainLegacyKeys: 5,
    legacyMaxAgeMs: 90 * day,
  },
});

await bot.start();
const status = bot.encryptionKeys();
```

| Option or method | Behavior |
| --- | --- |
| `keyRotation` | Enables automatic rotation in split mode. Omit it for manual rotation only. |
| `intervalMs` | Time since the active key was activated. Minimum 1,000 ms. |
| `retainLegacyKeys` | Number of retired keys to keep. Default 5, range 1–100. |
| `legacyMaxAgeMs` | Optional age limit for retired keys. Minimum 1,000 ms. |
| `await bot.rotateEncryptionKey()` | Rotate the split key explicitly. |
| `bot.encryptionKeys()` | Inspect public keys, timestamps and pending rotation status. |

Startup performs at most one overdue rotation. Future rotations are scheduled while the Bot runs. Stop and close cancel timers and wait for in-flight key work. The account signing key stays with the [signer](SIGNERS.md).

## Durable custody and failure recovery

The account keyring lives in the internal database and is shared across modes. It holds split secrets, activation and retirement metadata, and any pending signed key declaration. `storageKey` encrypts the payloads. Preserve the database and original key across restarts.

Rotation checks the latest observed authenticated own `10044`, generates a candidate, and stores the candidate and exact signed declaration before publication. The new key can then decrypt incoming messages. The Bot activates it for outgoing messages after the declaration is accepted in the configured write and DM sets and the activation is saved.

An uncertain or failed publication leaves the old outgoing key active and the candidate available for retry. Startup and new sends resume the staged declaration. Pending message envelopes retain their original keys, ciphertext, IDs and relay targets through rotation.

## Legacy count and expiration

Retired keys let the Bot decrypt messages from peers using stale routing data. Pruning runs after a successful split-key rotation. It applies the optional age limit first, then the count limit. The key just retired by that rotation remains available.

An envelope addressed only to an evicted key can no longer be decrypted. Local text already decrypted remains readable. SQLite pages, WAL files and backups may retain older data. See [security](../SECURITY.md) for storage and credential boundaries.

## Explicit migration and upgrade

When using a different mode with the same account, close the old Bot and keep its database and storage key. If the account already advertises a different key, acknowledge the exact locally held key in `announce()` before starting.

```ts
const split = new Bot({ mode: "nip4e", signer, database, storageKey, relays });
await split.announce({ replaceEncryptionKey: await signer.getPublicKey() });
await split.start();
const previousSplitKey = split.encryptionKeys().currentPublicKey;
await split.close();

const standard = new Bot({ signer, database, storageKey, relays });
await standard.announce({ replaceEncryptionKey: previousSplitKey });
await standard.start();
```

A replacement must match the latest verified declaration and a locally available decryption key. Conflicts raise `Nip4eCompatibilityError`. Finish pending key publication in its original mode before switching. History, inbox, outbox and sessions remain mode-scoped even though the keyring is shared.

## Automatic same-identity key synchronization

In split mode, a Bot missing its advertised key can request it from another device using the same signing identity. The requester sends signed kind `4454`. A device holding the key can return an encrypted kind `4455` response tied to that request. The Bot checks the author, request binding and key against the latest observed declaration, then stores the key before adopting it.

Authorization relies on the account signature. Requests can grant access to held split keys, so give signing permission accordingly. Identity signing secrets are never transferred. A PsstPsst device may require approval in its own UI.

Set `keySync: false` to disable requests and responses. The default request timeout is 30 seconds. A timeout or unavailable peer leaves held keys and pending rotation state intact. Run `npm run example:key-sync` after building to try two disposable in-memory devices.
