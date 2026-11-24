import { z } from "zod";
import {
  allowlist,
  requestTiming,
  Bot,
  type BotOptions,
  type BotCommandDefinition,
  type CommandAddress,
  type Signer,
  type MessageStorage,
  type Transport,
} from "../src/index.js";
import { Client } from "../src/client.js";

// Compile-only checks; no clients or databases are created at runtime.
function configurations(
  signer: Signer,
  messageStorage: MessageStorage,
  transport: Transport,
) {
  const options: BotOptions = { signer, messageStorage };
  void new Bot(options);
  void new Bot({ signer, transportOptions: { eoseTimeoutMs: 25000 } });
  void new Bot({ signer, mode: "nip4e", keyRotation: { intervalMs: 1000 } });
  // @ts-expect-error Replacing internal persistence is not supported.
  void new Bot({ signer, storage: messageStorage, database: ":memory:" });
  // @ts-expect-error Transport backend choices are exclusive.
  void new Bot({
    signer,
    transport,
    transportOptions: { eoseTimeoutMs: 1000 },
  });
  // @ts-expect-error Rotation requires split-key mode.
  void new Bot({ signer, mode: "nip17", keyRotation: { intervalMs: 1000 } });
  // @ts-expect-error Account resolution belongs to the signer.
  void new Bot({ signer, identity: { pubkey: "invalid" } });
  // @ts-expect-error Signer capabilities are required.
  void new Bot({ database: ":memory:" });
  // @ts-expect-error Construction is asynchronous through Client.create.
  new Client({ signer });
  // @ts-expect-error The public Bot owns its internal client.
  void new Bot(options).client;
}
void configurations;

function accountAccess(client: Client) {
  const pubkey: string = client.pubkey;
  // @ts-expect-error Internal protocol capabilities are not exposed.
  void client.identity;
  // @ts-expect-error Resolved configuration does not expose account secrets.
  void client.options.identity;
  return pubkey;
}
void accountAccess;

function storageBoundary(client: Client, storage: MessageStorage) {
  // @ts-expect-error Framework storage is private.
  void client.store;
  // @ts-expect-error Core persistence is private.
  void client.coreStore;
  storage.updateState("account", "rumor", "done");
  // @ts-expect-error Message and outbox states remain separate.
  storage.updateState("account", "rumor", "relay-accepted");
  // @ts-expect-error The public message state method is updateState.
  storage.updateMessageState("account", "rumor", "failed");
  // @ts-expect-error History backends cannot access keyrings.
  storage.getKeyring("account");
  // @ts-expect-error History backends cannot modify the outbox.
  storage.updateOutboxState("account", "event", "relay-accepted");
}
void storageBoundary;

function commandHandlers(bot: Bot, dynamic: BotCommandDefinition) {
  bot.command({ command: "implicit" }, () => {});
  // @ts-expect-error Commands require a definition object.
  bot.command("implicit", () => {});
  bot.command(
    { command: "public", scopes: ["kind:1", "kind:1111"] },
    async (ctx) => {
      const inputId: string = ctx.input.id;
      const prior = await ctx.thread({ limit: 10 });
      await ctx.reply(String(prior.entries.length));
      void inputId;
    },
  );
  bot.command(
    {
      command: "echo",
      title: "echo",
      description: "Run /echo in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    async (ctx, { text }) => {
      // @ts-expect-error A simple command may omit text.
      void (text satisfies string);
      await ctx.reply(text ?? "");
    },
  );

  const definition = {
    command: "configure",
    scopes: ["kind:14"],
    title: "Configure",
    description: "Configure a target.",
    args: z.object({
      count: z.bigint().meta({ label: "Count" }),
      enabled: z.boolean().meta({ label: "Enabled" }),
      target: z
        .object({
          kind: z.number().int(),
          pubkey: z.string(),
          identifier: z.string(),
          relays: z.array(z.string()),
        })
        .meta({ label: "Target", nipcdType: "address" }),
      mode: z.enum(["fast", "safe"]).optional().meta({ label: "Mode" }),
    }),
  } as const satisfies BotCommandDefinition;

  bot.command(
    definition,
    (_ctx, args) => {
      const count: bigint = args.count;
      const contextCount: bigint = _ctx.args.count;
      void contextCount;
      const enabled: boolean = args.enabled;
      const target: CommandAddress = args.target;
      const mode: "fast" | "safe" | undefined = args.mode;
      // @ts-expect-error Argument names are checked.
      void args.typo;
      // @ts-expect-error Optional values may be undefined.
      void (args.mode satisfies "fast" | "safe");
      // @ts-expect-error Values must match the schema.
      void (args.count satisfies string);
      return { count, enabled, target, mode };
    },
    {
      authorize: (_ctx, { args }) => args.enabled && args.count > 0n,
    },
  );

  bot.command(dynamic, (_ctx, args) => {
    const value: unknown = args.anyName;
    return value;
  });

  bot.command(
    {
      scopes: ["kind:14"],
      command: "ping",
      title: "Ping",
      description: "Reply pong.",
    },
    (_ctx, args) => {
      // @ts-expect-error This definition declares no arguments.
      void args.text;
    },
  );
}
void commandHandlers;

function conversationState(bot: Bot<{ visits: number; name: string }>) {
  bot.use(async (ctx, next) => {
    // @ts-expect-error Middleware runs before validation and has no valid args.
    void ctx.args;
    await next();
  });
  bot.handle(async ({ session }) => {
    const visits = await session.getItem("visits");
    session.setItem("visits", (visits ?? 0) + 1);
    session.removeItem("name");
    // @ts-expect-error Session keys come from the state type.
    await session.getItem("visit");
    // @ts-expect-error Values must match the selected key.
    session.setItem("visits", "one");
    // @ts-expect-error Deletion uses removeItem.
    session.setItem("name", undefined);
  });
}
void conversationState;

// Bot registration cannot accept legacy custom identifiers; wire helpers retain foreign d values.
function commandNamesOnly(bot: Bot) {
  // @ts-expect-error Commands are omitted from the next startup registry, not removed at runtime.
  bot.removeCommand("ping");
  bot.command(
    {
      command: "ping",
      title: "ping",
      description: "Run /ping in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    () => {},
    // @ts-expect-error The command registration options no longer include id.
    { id: "legacy" },
  );
  bot.command(
    {
      scopes: ["kind:14"],
      command: "ping",
      title: "Ping",
      description: "Ping",
      // @ts-expect-error Object-form command identifiers come from the command name.
      id: "legacy",
    },
    () => {},
  );
}
void commandNamesOnly;

function officialComponents(signer: Signer) {
  const bot = new Bot<{ count: number }>({ signer });
  bot.use(allowlist([]));
  bot.use(
    requestTiming({
      onTiming: (metric) => {
        const status: "success" | "failure" = metric.outcome;
        void status;
      },
    }),
  );
  // @ts-expect-error Configure sender authorization through bot.use(allowlist(...)).
  void new Bot({ signer, inboundPolicy: () => true });
  // @ts-expect-error Configure sender authorization through bot.use(allowlist(...)).
  void new Bot({ signer, allowlist: [] });
  // @ts-expect-error The SDK never replays inbound handlers.
  bot.retryInbox();
}
void officialComponents;

function delayedInput(
  bot: Bot,
  event: import("nostr-tools").Event | import("../src/protocol.js").Rumor,
) {
  const reply: Promise<import("../src/client.js").SendResult> = bot.reply(
    event,
    "done",
  );
  const thread: Promise<import("../src/public-thread.js").ThreadResult> =
    bot.thread(event, { limit: 10 });
  // @ts-expect-error No ID overload.
  bot.reply(event.id, "done");
  // @ts-expect-error No context/ref wrapper overload.
  bot.thread({ event });
  void reply;
  void thread;
  void bot.dmHistory(event.pubkey, { limit: 1 });
  // @ts-expect-error The public local history method is named dmHistory.
  void bot.history(event.pubkey);
  void bot.react(event);
  // @ts-expect-error No ID overload for reactions.
  void bot.react(event.id);
}
void delayedInput;

function sharedContext(ctx: import("../src/index.js").Context) {
  void ctx.react("👍");
  // @ts-expect-error Context reactions always target the current input.
  void ctx.react("👍", ctx.input.id);
  // @ts-expect-error Message lookup belongs to Bot.
  void ctx.getMessage(ctx.input.id);
  // @ts-expect-error Explicit local history lookup belongs to Bot.
  void ctx.history();
  // @ts-expect-error Shared handlers consume ctx.input instead of DM storage records.
  void ctx.message;
}
void sharedContext;
