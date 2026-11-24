import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Bot,
  allowlist,
  requestTiming,
  nsecSigner,
  generateSecretKey,
  type Context,
  type RequestTiming,
  type Transport,
} from "../src/index.js";
import { Client } from "./client.js";
import { Client as SignerClient } from "../src/client.js";
import { BotHandlers } from "../src/bot-handlers.js";
import {
  localNip17Identity,
  rumor,
  wrap,
  standardEnvelope,
} from "../src/protocol.js";
import { MemoryRelay } from "../examples/_support.js";
const urls = ["ws://memory.invalid"];
const transport: Transport = {
  query: async () => [],
  publish: async () => {},
  subscribe: () => ({ ready: Promise.resolve(), close() {} }),
  close() {},
};

test("official allowlist snapshots and validates keys and invokes the same middleware next", async () => {
  const identity = localNip17Identity(),
    other = localNip17Identity(),
    keys = [identity.pubkey],
    middleware = allowlist(keys);
  keys.splice(0, 1, other.pubkey);
  let calls = 0;
  const next = async () => {
    calls++;
  };
  await middleware({ sender: identity.pubkey } as Context, next);
  await middleware({ sender: other.pubkey } as Context, next);
  await allowlist([])({ sender: identity.pubkey } as Context, next);
  assert.equal(calls, 1);
  for (const values of [
    ["bad"],
    [identity.pubkey.toUpperCase()],
    ["npub1bad"],
    new Array(1),
    null,
    "not-an-array",
  ])
    assert.throws(() => allowlist(values as never), /lowercase hex/);
});
test("Bot and both Client entry points reject removed authorization options", async () => {
  const signer = nsecSigner(generateSecretKey()),
    identity = localNip17Identity();
  try {
    for (const old of [
      { allowlist: [] },
      { inboundPolicy: () => false },
      { guards: [() => false] },
    ]) {
      assert.throws(() => new Bot({ signer, ...old }), /Use bot.use/);
      assert.throws(() => new Client({ identity, ...old }), /Use bot.use/);
      await assert.rejects(
        SignerClient.create({ signer, ...old }),
        /Use bot.use/,
      );
    }
  } finally {
    await signer.close();
  }
});
test("middleware sees both live and recovered verified DM Context; own copies bypass middleware", async () => {
  const identity = localNip17Identity(),
    peer = localNip17Identity(),
    observed: string[][] = [];
  const client = new Client({
      identity,
      relays: urls,
      transport,
      database: ":memory:",
    }),
    bot = new BotHandlers(client);
  bot.use((ctx) => {
    observed.push([ctx.sender, ctx.input.text]);
  });
  try {
    await bot.start();
    const live = await wrap(
      rumor(peer.pubkey, identity.pubkey, "blocked"),
      peer,
      identity.pubkey,
      identity.pubkey,
      standardEnvelope,
    );
    assert.equal(await client.receive(live, "live"), true);
    await client.idle();
    assert.deepEqual(observed, [[peer.pubkey, "blocked"]]);
    assert.equal(client.history(peer.pubkey).messages.length, 0);
    const recovered = await wrap(
      rumor(peer.pubkey, identity.pubkey, "recovered"),
      peer,
      identity.pubkey,
      identity.pubkey,
      standardEnvelope,
    );
    assert.equal(await client.receive(recovered, "history"), true);
    assert.equal(await client.receive(recovered, "live"), false);
    const self = await wrap(
      rumor(identity.pubkey, peer.pubkey, "self copy"),
      identity,
      identity.pubkey,
      identity.pubkey,
      standardEnvelope,
    );
    assert.equal(await client.receive(self, "history"), true);
    await client.idle();
    assert.deepEqual(observed, [
      [peer.pubkey, "blocked"],
      [peer.pubkey, "recovered"],
    ]);
    assert.deepEqual(
      client.history(peer.pubkey).messages.map((message) => message.direction),
      ["outgoing"],
    );
  } finally {
    bot.dispose();
    await client.close();
  }
});
test("requestTiming reports exact processing-chain duration and no context or error fields", async (ctx) => {
  let now = 10;
  ctx.mock.method(performance, "now", () => now);
  const metrics: Readonly<RequestTiming>[] = [];
  const middleware = requestTiming({
    onTiming: (metric) => {
      metrics.push(metric);
    },
  });
  const context = new Proxy(
    {},
    {
      get() {
        assert.fail("Timing middleware must never inspect context");
      },
    },
  );
  await middleware(context, async () => {
    now += 25;
  });
  assert.deepEqual(metrics[0], { durationMs: 25, outcome: "success" });
  assert.ok(Object.isFrozen(metrics[0]));
  const original = new Error("PRIVATE RAW ERROR");
  await assert.rejects(
    middleware(context, async () => {
      now += 12;
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(metrics[1], { durationMs: 12, outcome: "failure" });
  assert.deepEqual(Object.keys(metrics[1]), ["durationMs", "outcome"]);
  assert.ok(!JSON.stringify(metrics).includes("PRIVATE"));
});
test("timing observers cannot delay success or swallow original errors", {
  timeout: 1000,
}, async () => {
  const original = new Error("original");
  for (const observer of [
    () => {
      throw new Error("observer");
    },
    async () => {
      throw new Error("observer");
    },
    () => new Promise<void>(() => {}),
  ]) {
    const middleware = requestTiming({ onTiming: observer });
    await middleware(undefined, async () => {});
    await assert.rejects(
      middleware(undefined, async () => {
        throw original;
      }),
      (error) => error === original,
    );
  }
  assert.throws(() => requestTiming(undefined as never), /onTiming/);
});
test("optional components work with public Bot.use and automatic command declarations, retaining handler failure state", async () => {
  const network = new MemoryRelay(),
    peerSigner = nsecSigner(generateSecretKey()),
    peerIdentity = await peerSigner.getPublicKey(),
    metrics: Readonly<RequestTiming>[] = [],
    errors: unknown[] = [];
  const bot = new Bot({
    signer: nsecSigner(generateSecretKey()),
    transport: network.transport(),
    relays: urls,
    database: ":memory:",
  });
  const peer = new Bot({
    signer: peerSigner,
    transport: network.transport(),
    relays: urls,
    database: ":memory:",
  });
  let reply = "";
  const original = new Error("PRIVATE HANDLER ERROR");
  bot.use(allowlist([peerIdentity]));
  bot.use(
    requestTiming({
      onTiming: (metric) => {
        metrics.push(metric);
        if (metric.outcome === "failure") throw new Error("observer failure");
      },
    }),
  );
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
      await ctx.reply("pong");
    },
  );
  bot.command(
    {
      command: "fail",
      title: "fail",
      description: "Run /fail in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    () => {
      throw original;
    },
  );
  bot.catch((error) => {
    errors.push(error);
  });
  peer.handle((ctx) => {
    reply = ctx.input.text;
  });
  try {
    await bot.start();
    await peer.start();
    const success = await peer.send(bot.pubkey, "/ping");
    await bot.idle();
    await peer.idle();
    assert.equal(reply, "pong");
    assert.equal(bot.getMessageState(success.id), "done");
    const failure = await peer.send(bot.pubkey, "/fail");
    await bot.idle();
    assert.equal(bot.getMessageState(failure.id), "failed");
    assert.deepEqual(errors, [original]);
    assert.deepEqual(
      metrics.map((metric) => metric.outcome),
      ["success", "failure"],
    );
    const publicCommands = await peer.discoverCommands({
      authors: [bot.pubkey],
      relays: urls,
    });
    assert.deepEqual(
      publicCommands.commands
        .map((command) => command.definition.command)
        .sort(),
      ["fail", "ping"],
    );
    for (const metric of metrics) {
      assert.deepEqual(Object.keys(metric), ["durationMs", "outcome"]);
      assert.ok(metric.durationMs >= 0);
    }
  } finally {
    await bot.close();
    await peer.close();
  }
});

for (const mode of ["nip17", "nip4e"] as const)
  test(`${mode}: optional policy does not widen ignored incoming reactions`, async () => {
    const identity = localNip17Identity(),
      peer = localNip17Identity();
    const { reactionRumor, splitEnvelope } = await import("../src/protocol.js");
    let checks = 0;
    const client = new Client({
        identity,
        mode,
        relays: urls,
        transport,
        database: ":memory:",
      }),
      bot = new BotHandlers(client);
    bot.use(async (ctx, next) => {
      checks++;
      assert.equal(ctx.sender, peer.pubkey);
      await next();
    });
    bot.use(allowlist([]));
    try {
      await bot.start();
      for (const policy of [standardEnvelope, splitEnvelope]) {
        const target =
          policy === standardEnvelope
            ? identity.pubkey
            : client.encryptionKeys().currentPublicKey;
        const event = await wrap(
          reactionRumor(peer.pubkey, identity.pubkey, "a".repeat(64), "👍"),
          peer,
          identity.pubkey,
          target,
          policy,
        );
        assert.equal(await client.receive(event, "history"), false);
        assert.equal(await client.receive(event, "live"), false);
      }
      await client.idle();
      assert.equal(checks, 0);
      assert.equal(client.history(peer.pubkey).messages.length, 0);
      assert.equal(client.store.evidence(peer.pubkey), undefined);
      assert.equal(client.store.pending().length, 0);
    } finally {
      bot.dispose();
      await client.close();
    }
  });

test("Bot middleware composes in Koa onion order and can short-circuit or catch downstream failure", async () => {
  const network = new MemoryRelay(),
    signer = nsecSigner(generateSecretKey()),
    peer = localNip17Identity();
  const bot = new Bot({
    signer,
    transport: network.transport(),
    relays: urls,
    database: ":memory:",
  });
  const calls: string[] = [];
  let outer: Context | undefined;
  const failure = new Error("downstream failure");
  bot.use(async (ctx, next) => {
    outer = ctx;
    calls.push("outer before");
    try {
      await next();
    } catch (error) {
      assert.equal(error, failure);
      calls.push("outer catch");
    }
    calls.push("outer after");
    await assert.rejects(next(), /more than once/);
  });
  bot.use(async (ctx, next) => {
    assert.equal(ctx, outer);
    calls.push("inner before");
    if (ctx.input.text === "stop") return;
    await next();
    calls.push("inner after");
  });
  bot.use((ctx, next) => {
    assert.equal(ctx, outer);
    calls.push("return next");
    return next();
  });
  bot.handle((ctx) => {
    assert.equal(ctx, outer);
    calls.push("handler");
    if (ctx.input.text === "throw") throw failure;
  });
  try {
    await bot.start();
    for (const [text, expected] of [
      [
        "ok",
        [
          "outer before",
          "inner before",
          "return next",
          "handler",
          "inner after",
          "outer after",
        ],
      ],
      ["stop", ["outer before", "inner before", "outer after"]],
      [
        "throw",
        [
          "outer before",
          "inner before",
          "return next",
          "handler",
          "outer catch",
          "outer after",
        ],
      ],
    ] as const) {
      calls.length = 0;
      await bot.receive(
        await wrap(
          rumor(peer.pubkey, bot.pubkey, text),
          peer,
          bot.pubkey,
          bot.pubkey,
          standardEnvelope,
        ),
        "live",
      );
      await bot.idle();
      assert.deepEqual(calls, expected);
    }
  } finally {
    await bot.close();
    await signer.close();
  }
});
