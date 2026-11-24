# Public notes, comments and private input

Chirli accepts authenticated kind 14 DMs and verified public kind 1/1111 commands. Applications still own message processing and authorization. There is no general event-adapter framework or AI dependency.

## Explicit registration and inbox

```ts
const bot = new Bot({
	signer,
	publicInbox: {
		relays: ["wss://your-inbox.example", "wss://your-second-inbox.example"],
		thread: { timeoutMs: 3000, maxEvents: 500, maxLookups: 16, maxDepth: 64 },
	},
	writeRelays: ["wss://your-write.example"],
});
bot.command(
	{ command: "ping", scopes: ["kind:14", "kind:1", "kind:1111"] },
	async (ctx) => {
		await ctx.reply("pong");
	},
);
await bot.start();
```

The example URLs are placeholders. Public inbox URLs must be chosen explicitly by the operator; no default public firehose opens. A public subscription selects only kinds declared by current commands, with a 500-event initial window per relay. Runtime additions update public subscriptions after command catalog synchronization. To remove commands, omit them from the next registry and restart; startup withdraws their definitions. DM subscription, metadata publication and automatic kind 31992 reconciliation retain their existing behavior.

`scopes` is required and must contain at least one supported kind. Duplicate or unsupported kind scopes are rejected. Same-type scopes are alternatives; different scope types combine. Scope checks use the authenticated rumor/public event and actual source relay, never configured-relay membership as proof of provenance. Registration/publication and routing use the same scopes.

Public invocation must start at content index zero. Either `/ping@npub...` or `/ping@nostr:npub...` explicitly selects the bot; no `p` tag is required. An unqualified `/ping` is accepted only when the distinct lowercase `p` targets consist solely of this bot. A conflicting qualifier remains rejected even with the bot's `p` tag. An ordinary structural reply or mention is never an invocation. These stricter public targeting rules are Chirli policy; NIP-CD itself permits multiple executors to match an unqualified invocation. Public `handle()`/middleware runs only for admitted registered invocations, not arbitrary notes. DM fallback behavior is unchanged.

Signatures, kind, structural references, source, invocation and scopes are checked before the SDK atomically claims the signed event ID. Own public events are ignored. Access middleware runs after the claim and receives a detached copy of the verified input. Commands can additionally use `authorize`.

## Shared context and privacy

`ctx.input` contains `{id,sender,createdAt,text,event}`. `createdAt` is Nostr seconds. `event` is the authenticated decrypted kind 14 rumor for DMs, or the signature-verified raw public event. Anonymous gift-wrap keys are never exposed as the sender.

`ctx.reply(text)` encrypts a DM when the input is private. For public inputs it signs kind 1111 with uppercase root scope and lowercase direct parent references, including mixed legacy kind 1/comment ancestry. Only the root author and direct parent author are copied. Missing/malformed legacy roots cause an error instead of a guessed attachment. An explicit modern root is preserved as declared in the signed comment; this does not prove the root's availability or truthfulness. A relay ACK means relay acceptance, never delivery or reading.

`ctx.replyFile(bytes, options?)` follows the same kind-1111 threading rules. It publishes the file URL and `imeta`; the bytes are uploaded **without encryption** for public input. The same call on a DM instead uploads ciphertext and replies with a kind-15 DM. Use `bot.replyFile(ctx.input.event, bytes, options?)` for delayed replies.

`ctx.react(reaction?)` signs a public [NIP-25](https://nips.nostr.com/25) kind-7 reaction. It references the target ID with an `e` tag and the target author with a `p` tag; kind-1111 targets also have a `k` tag. Omitting the reaction sends `+` (like). For a private input the same call sends an encrypted kind-7 rumor.

Public replies and reactions use configured `writeRelays` plus the configured inbox relay that supplied the input. Untrusted relay hints in tags do not initiate contacts; automatic destination-author relay discovery is not implemented. DM send options are rejected for public replies.

`ctx.session` uses separate `public:` thread keys for public input. Default storage namespaces also separate it from private peer sessions. A custom session store receives those prefixed keys and must preserve their separation and account isolation. Legacy unmarked chains may have an intermediate declared root and consequently a different session key until the application chooses a canonical key. Sessions and external side effects are not atomic with business completion.

The handler context has the same fields and methods for both kinds of input. Use `ctx.input` for the current input and `ctx.thread()` for preceding context. `bot.getMessage`, `bot.dmHistory`, `bot.observe`, message listing/state and `bot.send` remain private-message APIs.

## Lazy ancestor context

```ts
bot.command(
	{ command: "summarize", scopes: ["kind:14", "kind:1", "kind:1111"] },
	async (ctx) => {
		const result = await ctx.thread({ limit: 30 });
		const reply = await applicationProcessor(result.entries, {
			complete: result.complete,
		});
		await ctx.reply(reply);
	},
);
```

No history is sent anywhere automatically. `applicationProcessor` belongs to your application. The offline demo uses a deterministic mock.

`thread()` returns `{entries,complete,coverage,reason?}`. Entries have the same shape as `ctx.input`, ordered oldest ancestor to direct parent, excluding the trigger. Limits are 1..100, default 30.

- DMs use up to ten local 100-message pages from the current private conversation. Coverage is `local-conversation`, always `complete:false`/`local-only`; there is no relay archive claim. Equal-second entries use the local history ordering.
- Public input batches its known root: the root event, kind 1 `#e` and kind 1111 `#E`, plus coordinate `#a`/`#A` variants where applicable. Only the current ancestor path is selected, never siblings or descendants. Legacy marked and positional references are supported; marked mentions and embedded NIP-19 quotes are excluded from positional topology. Missing ancestors use bounded targeted lookups. Modern address parents with an exact event ID resolve that version.
- Missing ancestors, inconsistent roots, timeouts, query windows, cycles and entry/size/depth/lookup bounds produce incomplete results with a reason. Defaults: 3000 ms total, 500 verified events, 16 queries, 64 ancestor steps. The total timer returns without waiting for an unresponsive custom query; the Transport interface cannot abort acquired queries. Built-in transport operations retain their own finite budgets and are closed with owned resources. A complete ancestor chain means those signed references resolved within the window, not complete relay history or global availability.

## Claims and outgoing retries

The internal SQLite store claims eligible public IDs before middleware. Public input bodies, relay provenance and pending/failed callback work are not retained; the private `MessageStorage` is not involved. Eligible historical IDs are also claimed without running commands. Offline-gap commands received as history are not executed later as live duplicates.

Live attempts are serial per declared public root, and different roots can proceed concurrently. Returning early, failure or restart does not reopen a claim. A crash can interrupt an attempt or occur before its callback starts. Public replies and reactions use an independent outbox: after signing they are stored before publication, and `flushOutbox()` and reconnect retry the same signed event ID. Applications own any durable business jobs and idempotency.

## Command definitions and references

For a private command use `command({command:'ping',scopes:['kind:14']},handler)`. For trailing text declare `args:z.object({text:z.string().optional().meta({label:'Text',nipcdType:'text'})})`. No scope is inserted implicitly. Custom command identifiers are rejected; `d` is the command name. Renames are removal plus addition. Foreign protocol definitions retain their actual `d` values when decoded.

References: [NIP-22](https://nips.nostr.com/22), [NIP-CD draft](https://github.com/nostr-protocol/nips/blob/master/CD.md), and read-only review of Jumble's MIT-licensed structural/thread/routing patterns. No running Jumble device or public relay interoperability is covered by local tests.

## Application-owned delayed replies

Retain `ctx.input.event` to call `bot.reply(event,text)`, `bot.react(event,reaction?)` or `bot.thread(event,options)` after the handler finishes. Keep the full signed public event, not its ID. The SDK stores no incoming public body. Reverification is mandatory. A delayed reply or reaction uses configured write relays only; an immediate handler action can also use its configured source relay. Relay hints are never inferred from event tags. DM calls require the matching authenticated incoming record in the same account/mode store and protect the retained plaintext event. See [the shared API and offline example](API.md#replies-and-context-after-a-handler).

Public admission checks only a registered command head, verified target and scopes before enqueueing. NIP-CD argument decoding and Zod validation happen after middleware. This permits centralized invalid-argument handling without subscribing to arbitrary event handlers. History/replayed IDs still never run validation/error callbacks. An args-dependent authorize callback suppresses malformed-input error callbacks because no valid arguments exist to authorize a response. See [Zod arguments](API.md#zod-command-arguments).
