# NIP-CD command definitions

Command definitions and invocation syntax follow the [NIP-CD draft](https://github.com/nostr-protocol/nips/blob/master/CD.md). Each command has its own signed kind **31992** event and a stable `(31992, executor pubkey, d)` coordinate.

Kind **10992** is a user’s installed-command list. Chirli neither publishes it nor treats it as an executor-owned registry.

## Register the complete set before starting

```ts
import {z} from 'zod';

const bot = new Bot({ signer });
bot.command({ command: 'ping', scopes: ['kind:14'] }, async ctx => { await ctx.reply('pong'); });
bot.command({
  command: 'sum', scopes: ['kind:14'],
  title: 'Sum',
  description: 'Add two integers.',
  args: z.object({
    left: z.bigint().meta({label:'Left'}),
    right: z.bigint().meta({label:'Right'}),
  }),
}, async (ctx, { left, right }) => {
  await ctx.reply(String(left + right));
}, { authorize: ctx => allowedSenders.has(ctx.sender) });
await bot.start();
```

Command metadata is public and goes to `writeRelays`. The `authorize` callback controls execution. Register the complete command set before startup. Use one registry owner per account so different processes do not withdraw each other's commands.

## Automatic startup reconciliation

Before business subscriptions or pending handlers begin, startup:

1. Reads the executor's complete kind 31992 snapshot from every configured write relay, scoped to its identity author. This is one broad logical scan per relay, with bounded paging when necessary, never one query per command. No `#d` filter or kind 5 query is used for startup reconciliation.
2. Compares that snapshot with the complete local registry, keeps unchanged definitions and publishes missing/changed definitions.
3. Publishes NIP-09 kind 5 coordinate withdrawals for definitions present remotely but absent locally, plus explicit removals and durable pending withdrawals.

No separate executor-list event is published. An empty Bot registry withdraws observed remote definitions; an ordinary Client does not claim registry ownership. Command registration and running additions synchronize automatically; there is no publication opt-in or manual setup step.

Startup requires successful reads and writes on every configured write relay. A failed or detectably incomplete scan blocks reconciliation. A relay may silently cap or omit results, so a completed bounded scan is not proof of globally complete history. Local confirmed cache entries alone never establish fresh remote presence or cause repeated withdrawals after a relay removes the event. Durable pending definitions/withdrawals are distinct from confirmed cache and retain their exact event IDs on retry.

Relays commonly remove the targeted definition after accepting kind 5. Reconciliation therefore does not fetch remote deletion history. Local tombstones are retained for retries and monotonic re-registration timestamps. Definitions, withdrawals and different relay replicas are not published atomically; partial failure can expose mixed snapshots.

## Runtime addition and restart reconciliation

```ts
bot.command({ command: 'help', scopes: ['kind:14'] }, async ctx => { await ctx.reply('Available commands…'); });
// Optional: await the automatic background synchronization before reading a snapshot.
await bot.syncCommands();
```

The published `d` is always the command name in `bot.command()`. Custom `id` arguments, even those matching the command name, are rejected. To remove a command, omit it from the next complete startup registry and restart with the same account and relays. A rename is removal of the old command plus registration of a new command at a different coordinate. If publication fails, `flushAnnouncements()` or `syncCommands()` can optionally await/retry the same automatic process.

`syncCommands()` returns added, updated and removed identifiers only; it is an optional wait/retry helper. Closing the Bot preserves public definitions and durable pending work for restart.

## Discovery

```ts
const snapshot = await bot.discoverCommands({
  authors: [knownExecutorPubkey], relays: discoveryRelays,
});
```

Discovery independently queries author-scoped kind 31992 definitions and kind 5 withdrawals, verifies signatures and author binding, and selects the newest non-withdrawn coordinates. Optional `ids` adds `#d` only to the definition query; deletion queries stay author-scoped. No executor membership list filters results. The result is read-only and reports `coverage: 'relay-snapshot'` and `complete: false`.

Unlike startup reconciliation, discovery retains deletion verification because relays and cross-relay snapshots can contain stale definitions. Protocol helpers preserve an external definition's actual `d` (`CommandDefinition.id`) even if it differs from its trigger. This is distinct from the Nostr event's hash `event.id`. Bot registration accepts neither a custom `d` nor a custom event ID.

## Invocation and parsing

Invocations begin at content index zero:

```text
/<command>[@nostr:<npub>] [<arg>...] [<text>]
```

The qualifier is optional. Both `@npub` and `@nostr:npub` target the executor's identity key.

- Registration uses one object form with explicit scopes. To accept trailing text, declare an optional terminal `text` argument.
- A full definition supports positional `pubkey`, `event`, `address`, `relay`, `number`, `bool`, `enum`, `word` and `text` arguments. Numbers are parsed as `bigint`.
- A terminal `text` argument removes one separator and preserves the rest, including leading spaces and newlines.
- The first matching command owns the route. An unknown trigger, unselected target or scope mismatch can fall through to the DM `handle()`. Recognized, correctly targeted/scoped commands with invalid arguments never fall through. An authorization denial on the matched command stops routing.

## Scope rules

Bot requires at least one explicitly declared supported kind: `kind:14`, `kind:1` or `kind:1111`. Duplicate kind scopes are rejected. These exact scopes are published and checked against the verified input; no implicit DM fallback is added. Additional scopes narrow that match:

| Scope | Checks |
| --- | --- |
| `author:<pubkey>` | Verified sender identity |
| `relay:<url>` | The relay that actually supplied the message |
| `tag:<name>` | A nonempty value for that tag in the authenticated DM rumor or public event |
| `tag:<name>:<value>` | An exact tag value in the authenticated DM rumor or public event |

Scopes of the same type are alternatives. Different types must all match. Tag scopes are grouped by tag name. A configured relay alone does not establish message provenance. Bot rejects unsupported kind scopes. Public input additionally requires explicit inbox relays and an unambiguous target; see [PUBLIC.md](PUBLIC.md).

## Upgrade behavior

Replace `command('name', fn)` with `command({command:'name', scopes:['kind:14']}, fn)`; add an optional text argument schema if needed. Remove custom `id` from Bot registration code. Remove unwanted declarations from the next startup registry. On the next automatic reconciliation, old custom coordinates found in the relay snapshot are withdrawn and the name-derived coordinates are published. Existing foreign wire definitions remain decodable with their original identifiers.

The existing SQLite journal keys/schema are retained. Unsupported legacy executor-list events in command known/pending state and relay-announcement state are filtered out at load and never replayed. Supported pending definitions and kind 5 withdrawals retain their exact signed IDs. No remote legacy list is read, republished or automatically erased. Removed index exports/result fields are no longer part of the API.

Bot args are now a Zod 4 object; labels/types/order/required/enum choices generate the same protocol argument tags. The protocol CommandArgument structure and pure encode/decode/discovery APIs remain unchanged. See [supported schemas and terminal errors](API.md#zod-command-arguments).
