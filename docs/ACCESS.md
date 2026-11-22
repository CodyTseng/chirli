# Incoming sender allowlist

Set `allowlist` to control which authenticated accounts can send messages to your Bot.

```ts
import { Bot } from 'chirli';

const bot = new Bot({
  signer,
  database: './chirli.sqlite',
  allowlist: [trustedIdentityPubkey],
});
```

| Value | Incoming policy |
| --- | --- |
| Omitted | Accept all authenticated senders |
| `[]` | Deny all external senders |
| A list of pubkeys | Accept only the listed senders |

Use lowercase 64-character hex **account public keys**. Convert an `npub` to hex in your application. The account key is the author of the verified seal and the decrypted message. A giftwrap author, split messaging key or bunker connection key cannot identify an allowed sender.

Chirli copies the allowlist when constructing the Bot. To change the policy, close the Bot and create a new one with the desired list and the same signer, mode and database.

## What happens to denied messages

- A newly denied message is discarded before storage, middleware, commands and session access. `bot.receive()` returns `false`, the same result as for a duplicate or unsupported envelope.
- Existing history remains readable. Previously accepted unfinished work that the new policy denies is consumed without executing handlers. The stored receipt still deduplicates later copies.
- A newly denied message leaves no denial record. If the policy later changes, the same message may be accepted when received again. A copy received as history is stored without dispatch.

The allowlist applies to incoming senders in both modes. Outgoing sends and self copies follow the usual routing rules. For command-specific rules, use the `authorize` option described in [NIP-CD commands](NIP-CD.md). See [security](../SECURITY.md) for signer and local storage trust boundaries.

Run `npm run example:allowlist` after building to try the policy with disposable accounts and an in-memory relay.

## Official inbound policy

```ts
import { Bot, allowlist } from 'chirli';
const bot = new Bot({ signer, inboundPolicy: allowlist([trustedIdentityPubkey]) });
```

The optional `inboundPolicy` hook receives only the authenticated sender's lowercase hex identity string and must return a synchronous boolean. It cannot mutate validated messages because no message object is supplied. `allowlist(pubkeys)` validates and snapshots the array; an empty array denies all external senders. It is used at both the post-decrypt/pre-persistence gate and pending startup/retry gate. Historical/reconnect intake uses the same gate. Own copies keep their existing bypass and are not dispatched as incoming messages; signed same-identity account-control events remain outside this external-message policy.

The old `allowlist:[...]` option delegates to the same official implementation. When both options are supplied, the legacy restriction is checked first and both must pass; neither can broaden the other. Omit both for the existing open intake behavior. Denied new messages create no history/evidence/session/reply or business/timing middleware effect. Previously accepted history remains readable, and revoked pending work is consumed without dispatch as above.

Custom `InboundPolicy` functions should be pure/reentrant because the SDK can check them more than once. False is deliberate denial; exceptions and non-boolean/Promise results reject processing before new persistence rather than authorizing through truthiness. Operational policy failures can block history checkpoint progress and leave pending work retryable. `bot.use(allowlist(...))` is not the API: ordinary middleware runs too late to guarantee no incoming history. Use `inboundPolicy` explicitly.
