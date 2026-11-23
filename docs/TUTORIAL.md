# Build your first bot

Run the included bot, add a command and keep state between messages. Then use the same SDK in your own application.

## 1. Run the existing bot

Use Node.js 24+:

```sh
npm ci --ignore-scripts
npm run build
npm run bot:commands
```

Wait for the ready banner. Send `/ping` to its printed npub from another Nostr account. Press Ctrl+C to stop.

On first launch the runner creates credentials beside `.chirli/bot.sqlite`. Later launches reuse them and the database. Local storage is plaintext unless a storage key is configured. To configure an existing nsec, bunker or custom relays, follow [live setup](../examples/live/README.md).

## 2. Add a command

Add this import at the top of `examples/live/commands.ts`:

```ts
import { npubEncode } from 'nostr-tools/nip19';
```

Register the command inside the existing `runLive` callback:

```ts
bot.command({ command: 'hello', scopes: ['kind:14'] }, async ctx => {
  await ctx.reply(`Hello, nostr:${npubEncode(ctx.sender)}!`);
});
```

Rebuild and restart:

```sh
npm run build
npm run bot:commands
```

Send `/hello` to get a greeting with a `nostr:npub1…` mention. Clients that support inline mentions can display it as the sender's profile name. See [NIP-27](https://github.com/nostr-protocol/nips/blob/master/27.md).

`runLive` is an example application helper, not an SDK API. It selects a signer, constructs and starts a Bot, prints readiness and closes application-owned resources on signals. See [runtime.ts](../examples/live/runtime.ts).

### Validate command parameters with Zod

The existing live commands example already imports z from zod; keep that import once. Add only these imports:

```ts
import {InvalidArgsError} from 'chirli';
import {randomInt} from 'node:crypto';
```

Inside the existing runLive callback, register shared error handling before the command:

```ts
bot.use(async (ctx, next) => {
  try { await next(); }
  catch (error) {
    if (!(error instanceof InvalidArgsError)) throw error;
    await ctx.reply('Usage: /roll <1..20>');
  }
});

bot.command({
  command:'roll', scopes:['kind:14'],
  args:z.object({sides:z.bigint().min(1n).max(20n).meta({label:'Sides'})}),
}, async (ctx, args) => {
  // Both entry points contain the same validated output.
  const rolled=randomInt(1,Number(ctx.args.sides)+1);
  await ctx.reply(`Rolled ${rolled} on a ${args.sides}-sided die.`);
});
```

Rebuild and restart, then send `/roll 6`: the reply is `Rolled N on a 6-sided die.`, with N in 1..6. `/roll`, `/roll invalid` and `/roll 21` each produce `Usage: /roll <1..20>` from the shared middleware, never the command handler. Arguments are decoded by NIP-CD before Zod runs; number tokens produce bigint. No response or retry is added when no error handler is configured. Plain fallback does not receive invalid arguments for a recognized, correctly targeted/scoped command.

Only command handlers have typed ctx.args; middleware uses the ordinary context before validation and sees no args after next returns. Use `.meta({nipcdType:'text'})` for a final free-text string; plain strings are words. See [schema support](API.md#zod-command-arguments) for optional/address fields and unsupported transforms. To run these valid/invalid examples without any external connection, build and run `npm run example:commands`; its /roll handler uses the same schema and middleware.

For commands with args-dependent authorize, invalid input is silently terminated: an invalid request cannot authorize a usage reply. A validator exception before authorization bypasses reply-capable middleware/catch observers and reaches operational onError plus failed/retry state unchanged. Other business errors keep the normal retry contract.

## 3. Persist conversation state

Use the conversation’s key-value storage through `ctx.session`. The handler supplies the default when a key is missing.

```ts
const bot = new Bot<{ visits: number }>({ signer, database: './chirli.sqlite' });

bot.command({ command: 'visit', scopes: ['kind:14'] }, async ctx => {
  const visits = (await ctx.session.getItem('visits') ?? 0) + 1;
  ctx.session.setItem('visits', visits);
  await ctx.reply(`Visit ${visits}`);
});

await bot.start();
```

Send `/visit` twice, restart with the same account and database, then send it again. The count continues because the default session backend uses SQLite.

Call `ctx.session.removeItem(key)` to delete one value or `ctx.session.clear()` to reset the current conversation. Writes and deletions are saved after successful processing. A failed handler discards its changes. See [conversation sessions](SESSIONS.md) for a complete custom `sessionStore` example.

## 4. Choose durable work and error handling

Register a handler for messages with no matching command:

```ts
bot.handle(async ctx => {
  await ctx.reply('Message received');
});
```

Use `bot.use()` for shared middleware before routing. Middleware can await `next()` to continue to the command or text handler. Use `observe()` for independent receipt monitoring. Observers do not determine processing success.

```ts
bot.catch((error, ctx) => {
  // Observe the failure using your application's sanitized diagnostics.
});
```

`Bot.catch()` observes session, middleware and business errors. Business errors remain failed/retryable even if the observer throws. Framework InvalidArgsError is different: it is terminal by default, never reaches the business handler or plain fallback, and is silent unless middleware or bot.catch explicitly handles it.

Inspect `bot.getMessageState(id)` or `bot.listMessages({ state: 'failed' })`. Retry from application management code, outside message handlers:

```ts
await bot.retryInbox({ ids: [failedMessageId] });
```

Handlers are serial per conversation. Calling `idle()`, `retryInbox()`, `stop()` or `close()` from a handler would wait on itself and is rejected. Use `requestStop()` to request shutdown and drain from outside the handler.

## 5. Understand public command synchronization

All commands are public on configured write relays. Their definitions are synchronized before Bot startup finishes. Register the complete command set before starting; definitions absent locally are withdrawn.

- To remove a command, omit it from the complete registry and restart with the same account/relays; startup publishes the withdrawal. Runtime additions remain supported.
- Declare a typed argument schema in `command()` for typed arguments. Registration accepts an `authorize` callback.
- Set `inboundPolicy: allowlist(pubkeys)` to authorize senders before persistence and handlers.
- Use `discoverCommands()` to inspect metadata; discovery never installs handlers.

Commands are declared automatically as kind `31992`, with `d` derived from the command name. Withdrawals use kind `5`; user-installed kind `10992` lists are untouched. See [commands](NIP-CD.md) for the complete contract.

## 6. Move into your own application

The package is not published yet. Create a local tarball from this checkout:

```sh
npm run build
npm pack --ignore-scripts
```

Install the resulting tarball in your ESM application, for example `npm install /absolute/path/to/chirli/chirli-0.1.0.tgz`. Import from `chirli`, without internal source paths.

Construct the Bot, register handlers and await startup:

```ts
import { Bot, nsecSigner } from 'chirli';

const signer = nsecSigner(nsecFromYourSecretManager);
const bot = new Bot({
  signer,
  database: './chirli.sqlite',
});

bot.command({ command: 'ping', scopes: ['kind:14'] }, async ctx => {
  await ctx.reply('pong', { replyTo: ctx.message.id });
});

await bot.start();
console.log(bot.pubkey);
```

Use `bunkerSigner(uri, { clientSecret })` through the same interface when signing remotely. Keep the NIP-46 client key for subsequent runs. Register handlers, then await `bot.start()` before displaying the public identity.

On shutdown, stop application timers and await their work, close the Bot, then close injected resources. Bot closes only its internally created transport/storage; signers and other injected resources remain yours.

For a complete application lifecycle, adapt the existing [live runner](../examples/live/runtime.ts). For isolated API examples, use the [12 offline walkthroughs](../examples/README.md).
