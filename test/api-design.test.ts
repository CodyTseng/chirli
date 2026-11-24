import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity, createSplitIdentity } from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { npubEncode } from "nostr-tools/nip19";
import {
  nsecSigner,
  generateSecretKey,
  type Message,
  type Transport,
  type ProtocolMode,
  type SessionStore,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { rumor, wrap, standardEnvelope } from "../src/protocol.js";
const url = "ws://api.invalid";
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function wire(overrides: Partial<Transport> = {}): Transport {
  return {
    query: async () => [],
    publish: async () => {},
    subscribe: () => ({ ready: Promise.resolve(), close() {} }),
    close() {},
    ...overrides,
  };
}
function client(transport = wire(), mode: ProtocolMode = "nip17") {
  return new Client({
    identity: mode === "nip17" ? createIdentity() : createSplitIdentity(),
    mode,
    transport,
    relays: [url],
    database: ":memory:",
    keySync: false,
    recovery: false,
  });
}
async function deliver(
  target: Client,
  sender: ReturnType<typeof createIdentity>,
  text: string,
) {
  const r = rumor(sender.pubkey, target.pubkey, text);
  await target.receive(
    await wrap(r, sender, target.pubkey, target.pubkey, standardEnvelope),
    "live",
  );
  await target.idle();
  return r.id;
}
for (const mode of ["nip17", "nip4e"] as const)
  test(`${mode}: simple and typed commands accept optional bare/prefixed qualifiers and preserve text`, async () => {
    const c = client(wire(), mode),
      bot = new Bot(c),
      peer = createIdentity(),
      other = createIdentity();
    const simple: string[] = [],
      typed: bigint[] = [];
    let fallback = 0;
    bot.command(
      {
        command: "echo-text",
        title: "echo-text",
        description: "Run /echo-text in a private message.",
        scopes: ["kind:14"],
        args: z.object({
          text: z
            .string()
            .optional()
            .meta({ label: "Text", nipcdType: "text" }),
        }),
      },
      (_ctx, { text }) => {
        simple.push(text ?? "");
      },
      {},
    );
    bot.command(
      {
        scopes: ["kind:14"],
        command: "add",
        title: "Add",
        description: "Add",
        args: z.object({ n: z.bigint().meta({ label: "N" }) }),
      },
      (_ctx, { n }) => {
        typed.push(n);
      },
      {},
    );
    bot.handle(() => {
      fallback++;
    });
    assert.deepEqual(
      bot.getCommandDefinitions().map(({ id }) => id),
      ["echo-text", "add"],
    );
    try {
      await c.start();
      for (const suffix of [
        "",
        `@${npubEncode(c.pubkey)}`,
        `@nostr:${npubEncode(c.pubkey)}`,
      ]) {
        await deliver(c, peer, `/echo-text${suffix}   literal\nnostr:text  `);
        await deliver(c, peer, `/add${suffix} nostr:12`);
      }
      assert.deepEqual(simple, Array(3).fill("  literal\nnostr:text  "));
      assert.deepEqual(typed, [12n, 12n, 12n]);
      for (const text of [
        `/echo-text@nostr:${npubEncode(other.pubkey)} ignored`,
        " /echo-text ignored",
        "prefix /add 1",
        "/echo-text@npub1bad ignored",
        "/add invalid",
      ])
        await deliver(c, peer, text);
      assert.equal(fallback, 4);
      assert.equal(simple.length, 3);
    } finally {
      bot.dispose();
      await c.close();
    }
  });

test("Bot detaches without stopping Client and injected transport remains application-owned", async () => {
  let closed = 0;
  const shared = wire({
      close() {
        closed++;
      },
    }),
    c = client(shared),
    a = new Bot(c),
    b = new Bot(c),
    peer = createIdentity();
  let handled = 0;
  a.command(
    {
      command: "a",
      title: "a",
      description: "Run /a in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    () => {},
    {},
  );
  b.command(
    {
      command: "b",
      title: "b",
      description: "Run /b in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    () => {
      handled++;
    },
    {},
  );
  try {
    await c.start();
    await a.close();
    a.dispose();
    assert.equal(a.getCommandDefinitions().length, 0);
    assert.throws(
      () =>
        a.command(
          {
            command: "later",
            title: "later",
            description: "Run /later in a private message.",
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
      /disposed/,
    );
    await deliver(c, peer, "/b");
    assert.equal(handled, 1);
    assert.equal(closed, 0);
    b.dispose();
    await c.close();
    assert.equal(closed, 0);
    const owned = new Client({
      identity: createIdentity(),
      transport: shared,
      database: ":memory:",
      relays: [url],
    });
    const bot = new Bot(owned);
    await Promise.all([bot.close(), bot.close()]);
    await owned.close();
    assert.equal(closed, 0);
    shared.close();
    assert.equal(closed, 1);
  } finally {
    a.dispose();
    b.dispose();
    await c.close();
  }
});

test("receipt observers are isolated from a failed business attempt and cannot mutate processing input", async () => {
  const c = client(),
    peer = createIdentity();
  let attempts = 0,
    observations = 0;
  const errors: unknown[] = [];
  c.onError((error) => {
    errors.push(error);
  });
  c.on("message", (message) => {
    observations++;
    (message as Message).text = "changed";
    throw new Error("observer");
  });
  c.on("message", async () => {
    throw new Error("async observer");
  });
  c.handle((message) => {
    assert.equal(message.text, "original");
    if (++attempts === 1) throw new Error("business");
  });
  try {
    await c.start();
    const id = await deliver(c, peer, "original");
    await settle();
    assert.equal(c.getMessageState(id), "failed");
    assert.equal(observations, 1);
    await c.stop();
    await c.start();
    await c.idle();
    assert.equal(c.getMessageState(id), "failed");
    assert.equal(attempts, 1);
    assert.equal(observations, 1);
    assert.equal(errors.length, 3);
  } finally {
    await c.close();
  }
});

test("message inspection paginates failed rows without restarting work", async () => {
  const c = client(),
    peer = createIdentity(),
    attempts = new Map<string, number>();
  let fail = true;
  c.handle((message) => {
    attempts.set(message.id, (attempts.get(message.id) ?? 0) + 1);
    if (fail) throw new Error("retry");
  });
  try {
    await c.start();
    const first = await deliver(c, peer, "first"),
      second = await deliver(c, peer, "second");
    const page = c.listMessages({ state: "failed", limit: 1 });
    assert.equal(page.entries.length, 1);
    assert.ok(page.nextCursor);
    const next = c.listMessages({
      state: "failed",
      limit: 1,
      cursor: page.nextCursor,
    });
    assert.equal(next.entries.length, 1);
    assert.notEqual(next.entries[0].message.id, page.entries[0].message.id);
    assert.equal(next.nextCursor, undefined);
    fail = false;
    await c.stop();
    await c.start();
    await c.idle();
    assert.equal(c.getMessageState(first), "failed");
    assert.equal(c.getMessageState(second), "failed");
    assert.equal(attempts.get(first), 1);
    assert.equal(attempts.get(second), 1);
    assert.equal(c.getMessageState("f".repeat(64)), undefined);
    assert.throws(() => c.listMessages({ cursor: "bad" }), /cursor/);
    assert.throws(() => c.listMessages({ limit: 0 }), /limit/);
    const third = await deliver(c, peer, "third");
    assert.equal(c.getMessageState(third), "done");
  } finally {
    await c.close();
  }
});

test("session keys see staged updates and only successful messages save a snapshot", async () => {
  const c = client(),
    peer = createIdentity();
  type State = { count: number; name: string };
  const data = new Map<string, Partial<State>>();
  let reads = 0,
    writes = 0;
  const sessionStore: SessionStore<State> = {
    async get(key) {
      reads++;
      return data.get(key);
    },
    async set(key, value) {
      writes++;
      data.set(key, value);
    },
  };
  const make = () => {
    const bot = new Bot(c, { sessionStore });
    bot.command(
      {
        command: "visit",
        title: "visit",
        description: "Run /visit in a private message.",
        scopes: ["kind:14"],
        args: z.object({
          text: z
            .string()
            .optional()
            .meta({ label: "Text", nipcdType: "text" }),
        }),
      },
      async ({ session }) => {
        const count = ((await session.getItem("count")) ?? 0) + 1;
        session.setItem("count", count);
        session.setItem("name", "Ada");
        assert.equal(await session.getItem("count"), count);
      },
    );
    bot.command(
      {
        command: "fail",
        title: "fail",
        description: "Run /fail in a private message.",
        scopes: ["kind:14"],
        args: z.object({
          text: z
            .string()
            .optional()
            .meta({ label: "Text", nipcdType: "text" }),
        }),
      },
      ({ session }) => {
        session.clear();
        session.setItem("count", 99);
        throw new Error("handler failed");
      },
    );
    bot.command(
      {
        command: "forget",
        title: "forget",
        description: "Run /forget in a private message.",
        scopes: ["kind:14"],
        args: z.object({
          text: z
            .string()
            .optional()
            .meta({ label: "Text", nipcdType: "text" }),
        }),
      },
      async ({ session }) => {
        session.removeItem("name");
        assert.equal(await session.getItem("name"), undefined);
      },
    );
    bot.command(
      {
        command: "reset",
        title: "reset",
        description: "Run /reset in a private message.",
        scopes: ["kind:14"],
        args: z.object({
          text: z
            .string()
            .optional()
            .meta({ label: "Text", nipcdType: "text" }),
        }),
      },
      async ({ session }) => {
        session.setItem("name", "Discarded");
        session.clear();
        assert.equal(await session.getItem("name"), undefined);
        assert.equal(await session.getItem("count"), undefined);
        session.setItem("name", "New name");
      },
    );
    bot.command(
      {
        command: "clear",
        title: "clear",
        description: "Run /clear in a private message.",
        scopes: ["kind:14"],
        args: z.object({
          text: z
            .string()
            .optional()
            .meta({ label: "Text", nipcdType: "text" }),
        }),
      },
      ({ session }) => {
        session.clear();
      },
    );
    bot.handle(() => {});
    return bot;
  };
  let bot = make();
  try {
    await c.start();
    await deliver(c, peer, "no state access");
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    await deliver(c, peer, "/visit");
    assert.deepEqual(data.get(peer.pubkey), { count: 1, name: "Ada" });
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    const failed = await deliver(c, peer, "/fail");
    assert.equal(c.getMessageState(failed), "failed");
    assert.deepEqual(data.get(peer.pubkey), { count: 1, name: "Ada" });
    assert.equal(writes, 1);
    bot.dispose();
    bot = make();
    await deliver(c, peer, "/visit");
    await deliver(c, peer, "/forget");
    assert.deepEqual(data.get(peer.pubkey), { count: 2 });
    assert.equal(writes, 3);
    const readsBeforeClear = reads;
    await deliver(c, peer, "/reset");
    assert.deepEqual(data.get(peer.pubkey), { name: "New name" });
    await deliver(c, peer, "/clear");
    assert.deepEqual(data.get(peer.pubkey), {});
    assert.equal(reads, readsBeforeClear);
    assert.equal(c.getSession(peer.pubkey), undefined);
  } finally {
    bot.dispose();
    await c.close();
  }
});

test("default identity and transport configuration retain identity AUTH without manual Transport construction", async () => {
  const identity = createIdentity(),
    c = new Client({
      identity,
      database: ":memory:",
      transportOptions: { eoseTimeoutMs: 12345 },
      relays: [url],
    });
  try {
    assert.equal(c.mode, "nip17");
    const transport = Reflect.get(c, "transport");
    assert.equal(transport.timeouts.eoseTimeoutMs, 12345);
    assert.equal(typeof transport.sign, "function");
    const signed = await transport.sign({
      kind: 22242,
      created_at: 1,
      tags: [],
      content: "",
    });
    assert.equal(signed.pubkey, identity.pubkey);
  } finally {
    await c.close();
  }
});

test("closing drains default sessions and preserves state inspection across signer-backed restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chirli-api-")),
    database = join(directory, "state.sqlite"),
    secret = generateSecretKey(),
    peer = createIdentity();
  const open = () =>
    Client.create({
      signer: nsecSigner(secret),
      database,
      transport: wire(),
      relays: [url],
      keySync: false,
      recovery: false,
    });
  let c = await open(),
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const bot = new Bot<{ count: number }>(c);
  bot.command(
    {
      command: "visit",
      title: "visit",
      description: "Run /visit in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    async (ctx) => {
      ctx.session.setItem(
        "count",
        ((await ctx.session.getItem("count")) ?? 0) + 1,
      );
      entered();
      await gate;
    },
    {},
  );
  try {
    await c.start();
    const r = rumor(peer.pubkey, c.pubkey, "/visit");
    await c.receive(
      await wrap(r, peer, c.pubkey, c.pubkey, standardEnvelope),
      "live",
    );
    await started;
    const closing = c.close();
    await settle();
    release();
    await closing;
    bot.dispose();
    c = await open();
    assert.equal(c.getSession<{ count: number }>(peer.pubkey)?.count, 1);
    assert.equal(c.getMessageState(r.id), "done");
    const malformed = Buffer.from(
      JSON.stringify([0, ["f".repeat(64)]]),
    ).toString("base64url");
    assert.throws(() => c.listMessages({ cursor: malformed }), /cursor/);
  } finally {
    release();
    bot.dispose();
    await c.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("handlers reject self-draining idle calls instead of blocking the conversation", {
  timeout: 2000,
}, async () => {
  const c = client(),
    peer = createIdentity();
  let processed = 0;
  c.handle(async () => {
    await assert.rejects(c.idle(), /inside a message handler/);
    processed++;
  });
  try {
    await c.start();
    const id = await deliver(c, peer, "idle control");
    assert.equal(processed, 1);
    assert.equal(c.getMessageState(id), "done");
  } finally {
    await c.close();
  }
});

test("Bot.catch observes session loading failures and cannot replace the original business error", async () => {
  const c = client(),
    peer = createIdentity(),
    failure = new Error("Session backend unavailable");
  const observed: unknown[] = [],
    reported: unknown[] = [];
  const bot = new Bot(c, {
    sessionStore: {
      get() {
        throw failure;
      },
      set() {},
    },
  });
  bot.handle(async (ctx) => {
    await ctx.session.getItem("count");
  });
  bot.catch((error) => {
    observed.push(error);
    throw new Error("Observer failure");
  });
  c.onError((error) => {
    reported.push(error);
  });
  try {
    await c.start();
    const id = await deliver(c, peer, "hello");
    assert.deepEqual(observed, [failure]);
    assert.ok(reported.includes(failure));
    assert.equal(c.getMessageState(id), "failed");
  } finally {
    await c.close();
    bot.dispose();
  }
});
