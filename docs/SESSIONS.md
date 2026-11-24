# Conversation sessions

Use `ctx.session` to keep business state between messages in the same DM conversation. Each conversation has its own keys. For example, a Bot can remember the current step of a form or count how many times one user has issued a command.

## Use the default SQLite storage

```ts
import { Bot } from "chirli";

const bot = new Bot<{ visits: number }>({
  signer,
  database: "./bot.sqlite",
});

bot.command({ command: "visit", scopes: ["kind:14"] }, async (ctx) => {
  const visits = ((await ctx.session.getItem("visits")) ?? 0) + 1;
  ctx.session.setItem("visits", visits);
  await ctx.reply(`Visit ${visits}`);
});

bot.command({ command: "reset", scopes: ["kind:14"] }, async (ctx) => {
  ctx.session.clear();
  await ctx.reply("Session reset.");
});

await bot.start();
```

The type argument checks keys and value types. Supply a default where you read a missing key. The Bot uses the internal `database` by default, scoped by account, protocol mode and the other participant's public key. Keep the same signer, mode and database across restarts. If you supply `storageKey`, it encrypts the stored payloads.

| Method | Behavior |
| --- | --- |
| `await ctx.session.getItem(key)` | Return a detached value or `undefined`. The first read loads the saved snapshot on demand. |
| `ctx.session.setItem(key, value)` | Stage a JSON-serializable value. Later reads in the current message see it. |
| `ctx.session.removeItem(key)` | Stage deletion of one key. |
| `ctx.session.clear()` | Reset the current conversation. Later writes in the same message become the new snapshot. |

Middleware and the chosen command or text handler share the same session for the current message. Successful processing commits changes once. If processing throws before the commit, the staged changes are discarded. If a custom store fails during commit, the error is reported and the SDK does not rerun the callback. A reply or other effect that already succeeded is not rolled back.

## Use a custom session store

Pass `sessionStore` to `new Bot()` to choose where business sessions are saved. `get(conversation)` returns the saved `Partial<State>` or `undefined`. `set(conversation, snapshot)` must replace the whole snapshot, so keys removed by `removeItem()` stay deleted and `clear()` persists an empty object. Both methods may be asynchronous.

The following example uses an application-owned SQLite file for a Bot whose session stores a visit count. The `signer` is the one configured for your Bot.

```ts
import { DatabaseSync } from "node:sqlite";
import { Bot, type SessionStore } from "chirli";

type State = { visits: number };

const db = new DatabaseSync("./my-sessions.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    conversation TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL
  ) STRICT
`);

const read = db.prepare("SELECT snapshot FROM sessions WHERE conversation = ?");
const write = db.prepare(`
  INSERT INTO sessions (conversation, snapshot) VALUES (?, ?)
  ON CONFLICT(conversation) DO UPDATE SET snapshot = excluded.snapshot
`);

const sessionStore: SessionStore<State> = {
  get(conversation) {
    const row = read.get(conversation);
    if (row === undefined) return undefined;
    if (typeof row.snapshot !== "string")
      throw new Error("Invalid session snapshot");

    const value: unknown = JSON.parse(row.snapshot);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid session snapshot");
    }
    if (!("visits" in value)) return {};
    if (
      typeof value.visits !== "number" ||
      !Number.isSafeInteger(value.visits)
    ) {
      throw new Error("Invalid session count");
    }
    return { visits: value.visits };
  },
  set(conversation, snapshot) {
    write.run(conversation, JSON.stringify(snapshot));
  },
};

const bot = new Bot({ signer, sessionStore });
bot.command({ command: "visit", scopes: ["kind:14"] }, async (ctx) => {
  const visits = ((await ctx.session.getItem("visits")) ?? 0) + 1;
  ctx.session.setItem("visits", visits);
  await ctx.reply(`Visit ${visits}`);
});
await bot.start();
```

This example dedicates the session file to one Bot account and mode. When sharing a backend, namespace keys by account and mode in addition to the conversation. The application owns the custom connection and its encryption. Close the Bot before closing the database with `db.close()` so in-flight handlers can finish saving.

## Inspect or replace a session outside a handler

Use `await bot.getSession(peerPubkey)` for a detached snapshot from the configured backend, or `await bot.setSession(peerPubkey, snapshot)` to replace it. To reset state from a handler, use `ctx.session.clear()` so the change is committed with that message's other session changes. Schedule external snapshot replacements outside active processing for that conversation to avoid overwriting a handler's pending edits.

Run `npm run build && npm run example:session` to try a session with two disposable accounts. See the [session demo](../examples/session.ts) and the [API reference](API.md).

Public kind 1/1111 handlers use separate `public:` conversation keys and internal session namespaces. They never read a DM peer session. Custom stores must preserve that separation and account isolation; public threads may involve multiple authors sharing one root session. See [public context](PUBLIC.md#shared-context-and-privacy).
