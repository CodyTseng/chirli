# Signers

Create a Bot with a signer. Local nsec and remote bunker credentials use the same API; application handlers never inspect the signing backend.

```ts
import { Bot, nsecSigner, bunkerSigner } from 'chirli';

const signer = nsecSigner(nsecFromYourSecretManager);
// Alternatively: const signer = bunkerSigner(bunkerUri);
const bot = new Bot({
  signer,
  database: './inbox.sqlite',
});
await bot.start();
console.log(bot.pubkey);
```

## Capability contract

`Signer` requires four asynchronous methods:

- `getPublicKey()` resolves the account public key, cached during startup.
- `signEvent(template)` signs the exact event requested.
- `nip44Encrypt(peer, plaintext)` encrypts using account-key NIP-44.
- `nip44Decrypt(peer, ciphertext)` decrypts using account-key NIP-44.

`nip04Encrypt` and `nip04Decrypt` are optional. Both built-in signers provide them, but Chirli messaging uses NIP-44. Custom signers can omit these methods and `close()`.

## Ownership

The application always owns the signer. Bot never calls its optional `close()`, including after failed construction. Close all Bots using a signer first, then call `await signer.close?.()` yourself. Local signer closure wipes its private copy of secret bytes; it never modifies the caller's byte array.

## Local nsec

`nsecSigner(nsecOrSecretBytes)` accepts a valid nsec or a 32-byte secret. Persist credentials in your application secret store; the SDK does not save identity signing secrets. Reuse the same credentials and database after restart.

## Remote bunker

```ts
const signer = bunkerSigner(bunkerUri);
```

A bunker URI identifies the service key. Chirli resolves the account key through NIP-46 and checks it on reconnect. A timed-out operation discards the connection. Later requests can reconnect using the same client key.

Approve requests in the signer's own app or configure its permissions ahead of time. If the signer sends a NIP-46 URL challenge, the request fails.

Persist and reuse `clientSecret` to keep the same bunker client identity across process restarts. Use `timeoutMs` to change the default 15-second deadline.

Closing releases the session without logout or deletion of remote credentials. The remote signer sees plaintext passed to its encryption/decryption methods.

## Messaging keys and failures

Default NIP-17 uses signer NIP-44. Explicit `mode:'nip4e'` generates/restores local split messaging keys; signer NIP-44 remains necessary for standard peers. Changing signer backend does not change Bot handlers, command registration, sessions or message processing.

Operational failures should raise `SignerError`. They remain retryable and prevent history checkpoint advancement. Ordinary decryption errors indicate invalid ciphertext. See [interoperability](INTEROPERABILITY.md) for key selection and [security](../SECURITY.md) for remote-signer trust boundaries.
