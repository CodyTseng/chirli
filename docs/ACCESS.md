# Incoming sender allowlist

Register `allowlist` as ordinary middleware to control which authenticated senders reach subsequent middleware, commands and the fallback handler.

```ts
import { Bot, allowlist } from "chirli";

const bot = new Bot({ signer, database: "./chirli.sqlite" });
bot.use(allowlist([trustedIdentityPubkey]));
```

| Middleware | Live processing |
| --- | --- |
| No allowlist middleware | All otherwise eligible, authenticated inputs continue |
| `bot.use(allowlist([]))` | Stop every external live input |
| `bot.use(allowlist(pubkeys))` | Continue only for a listed sender |

Use lowercase 64-character hex **account public keys**. Convert an `npub` to hex in your application. For private input, the key is the authenticated author of the seal and decrypted rumor; for public input, it is the verified event author. A giftwrap author, split messaging key or bunker connection key is not an account identity. The helper validates and snapshots its list. Register it before any middleware whose effects should be restricted.

Custom access checks use the same `bot.use(async (ctx, next) => { ... })` API. Read the verified author from `ctx.input.sender` and call `await next()` only if allowed. Use the command's `authorize` option for a single command. Authentication and the atomic ID claim happen before any of these checks.

## What happens to denied messages

- An eligible input ID stays claimed even if middleware returns without calling `next()` or throws. A duplicate does not revisit middleware after configuration changes, reconnection or restart. `bot.receive()` can return `true` for a newly claimed input that middleware later stops; this does not mean the sender was authorized.
- If the allowlist stops a DM from reaching routing, the SDK does not add it to conversation history or invoke receipt observers. DMs recovered after the first activation go through the same middleware. The allowlist does not erase existing history.
- Outgoing sends, eligible self copies and signed same-identity control traffic do not pass through this middleware. This is neither an outbound ACL nor a rate limiter. Crypto and remote signer work may occur before the sender is authenticated.

Replace the old `inboundPolicy`, `guards` or constructor `allowlist` option with registered middleware. These constructor options now throw instead of silently running unfiltered. See [security](../SECURITY.md) for signer and local storage boundaries.
