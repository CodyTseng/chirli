import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Bot,
  generateSecretKey,
  nsecSigner,
  type Transport,
} from "../src/index.js";
import { MemoryRelay } from "../examples/_support.js";

test("new Bot registers commands before start and publishes discovery before subscribing", async () => {
  const relay = new MemoryRelay();
  const local = nsecSigner(generateSecretKey()),
    peerSigner = nsecSigner(generateSecretKey());
  const wire = relay.transport(),
    peerWire = relay.transport();
  let pubkeyReads = 0;
  const signer = {
    ...local,
    getPublicKey: () => {
      pubkeyReads++;
      return local.getPublicKey();
    },
  };
  const published = new Set<number>();
  const commandScopes = new Map<string, string[][]>();
  let inboxes = 0;
  const transport: Transport = {
    ...wire,
    async publish(relays, event) {
      await wire.publish(relays, event);
      published.add(event.kind);
      if (event.kind === 31992) {
        const name = event.tags.find((tag) => tag[0] === "command")?.[1];
        assert.ok(name);
        commandScopes.set(
          name,
          event.tags.filter((tag) => tag[0] === "s"),
        );
      }
    },
    subscribe(relays, filter, receive) {
      if (filter.kinds?.includes(1059)) {
        inboxes++;
        for (const kind of [10044, 10002, 10050, 10063, 31992])
          assert.ok(published.has(kind), String(kind));
      }
      return wire.subscribe(relays, filter, receive);
    },
  };
  const options = {
    database: ":memory:",
    relays: ["wss://demo.invalid"],
    recovery: false as const,
  };
  const bot = new Bot({ ...options, signer, transport });
  const peer = new Bot({ ...options, signer: peerSigner, transport: peerWire });
  let replies = 0;
  let authorizationChecks = 0;
  const routedMessages: string[] = [];
  const fallbackMessages: string[] = [];
  peer.handle(({ input }) => {
    if (input.text === "pong") replies++;
  });
  bot.handle(({ input }) => {
    fallbackMessages.push(input.text);
  });
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
    async (ctx) => {
      assert.equal(
        routedMessages.at(-1),
        "/ping",
        "middleware runs before command routing",
      );
      await assert.rejects(bot.close(), /inside a message handler/);
      await ctx.reply("pong");
    },
    {
      authorize: (ctx) => {
        authorizationChecks++;
        return ctx.sender === peer.pubkey;
      },
    },
  );
  assert.throws(
    () =>
      bot.command(
        {
          command: "ping",
          title: "ping",
          description: "Run /ping in a private message.",
          scopes: ["kind:14"],
          args: z.object({
            text: z
              .string()
              .optional()
              .meta({ label: "Text", nipcdType: "text" }),
          }),
        },
        () => {},
      ),
    /Duplicate/,
  );
  bot.command(
    {
      command: "denied",
      title: "denied",
      description: "Run /denied in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    () => {
      assert.fail("An unauthorized command must not run");
    },
    { authorize: () => false },
  );
  bot.use(async ({ input }, next) => {
    routedMessages.push(input.text);
    await next();
  });
  const author = await peerSigner.getPublicKey();
  const restricted = {
    command: "restricted",
    title: "Restricted",
    description: "Reply to an allowed author.",
  };
  assert.throws(
    () =>
      bot.command({ ...restricted, scopes: ["kind:14", "kind:7"] }, () => {}),
    /supported kind scopes/,
  );
  assert.throws(
    () =>
      bot.command({ ...restricted, scopes: ["kind:14", "kind:14"] }, () => {}),
    /distinct/,
  );
  bot.command(
    { ...restricted, scopes: ["kind:14", `author:${author}`] },
    () => {},
  );
  bot.command(
    {
      scopes: ["kind:14"],
      command: "help",
      title: "Help",
      description: "Show help.",
    },
    () => {},
  );
  try {
    assert.equal(pubkeyReads, 0);
    assert.equal(inboxes, 0);
    assert.equal(bot.getCommandDefinitions()[0].command, "ping");
    const starting = bot.start();
    assert.equal(bot.start(), starting);
    await starting;
    assert.deepEqual(commandScopes.get("ping"), [["s", "kind:14"]]);
    assert.deepEqual(commandScopes.get("help"), [["s", "kind:14"]]);
    assert.deepEqual(commandScopes.get("restricted"), [
      ["s", "kind:14"],
      ["s", `author:${author}`],
    ]);
    await peer.start();
    assert.equal(pubkeyReads, 1);
    assert.equal(inboxes, 1);
    const ping = await peer.send(bot.pubkey, "/ping");
    assert.equal(ping.status, "relay-accepted");
    await bot.idle();
    await peer.idle();
    assert.equal(replies, 1);
    assert.equal(bot.getMessageState(ping.id), "done");
    assert.equal(authorizationChecks, 1);
    assert.deepEqual(fallbackMessages, []);
    await peer.send(bot.pubkey, "hello");
    await bot.idle();
    const denied = await peer.send(bot.pubkey, "/denied");
    await bot.idle();
    assert.equal(bot.getMessageState(denied.id), "done");
    assert.deepEqual(fallbackMessages, ["hello"]);
    assert.deepEqual(routedMessages, ["/ping", "hello", "/denied"]);
    await bot.stop();
    await bot.start();
    assert.equal(inboxes, 2);
    assert.equal(bot.getCommandDefinitions()[0].command, "ping");
    await bot.close();
    await assert.rejects(bot.start(), /closed/);
    assert.equal(await local.getPublicKey(), bot.pubkey);
  } finally {
    await Promise.all([bot.close(), peer.close()]);
    wire.close();
    peerWire.close();
    await Promise.all([local.close(), peerSigner.close()]);
  }
});

test("closing during signer resolution prevents subscription and releases the Bot", async () => {
  const local = nsecSigner(generateSecretKey());
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signer = {
    ...local,
    async getPublicKey() {
      await ready;
      return local.getPublicKey();
    },
  };
  const transport: Transport = {
    async query() {
      assert.fail("Startup queried a relay after close");
    },
    async publish() {
      assert.fail("Startup published after close");
    },
    subscribe() {
      return assert.fail("Startup subscribed after close");
    },
    close() {
      assert.fail("Injected transport is application-owned");
    },
  };
  const bot = new Bot({ signer, database: ":memory:", transport });
  try {
    const starting = bot.start();
    const closing = bot.close();
    release();
    await Promise.all([starting, closing]);
    await assert.rejects(bot.start(), /closed/);
  } finally {
    release();
    await bot.close();
    await local.close();
  }
});
