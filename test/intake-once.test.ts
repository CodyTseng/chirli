import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Event } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import {
  allowlist,
  Bot,
  generateSecretKey,
  nsecSigner,
  type Context,
  type Transport,
} from "../src/index.js";
import {
  localNip17Identity,
  rumor,
  standardEnvelope,
  wrap,
} from "../src/protocol.js";
import { commentReply } from "../src/public-thread.js";

// All traffic is injected through Bot.receive. These addresses identify distinct
// sources; the injected transport never opens a socket or reaches public relays.
const relays = ["ws://127.0.0.1:8765", "ws://127.0.0.1:8766"];
const transport: Transport = {
  query: async () => [],
  publish: async () => {},
  subscribe: () => ({ ready: Promise.resolve(), close() {} }),
  close() {},
};

function persistedIds(database: string) {
  // A separate connection must see the committed ID before application work
  // proceeds, not just after the handler or shutdown has had time to save.
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    return reader
      .prepare("SELECT id FROM input_claims ORDER BY id")
      .all()
      .map(({ id }) => id);
  } finally {
    reader.close();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chirli-intake-once-"));
  const database = join(directory, "account.sqlite");
  const signer = nsecSigner(generateSecretKey());
  const sender = localNip17Identity();
  return {
    database,
    sender,
    make: () =>
      new Bot({ signer, database, relays, publicInbox: { relays }, transport }),
    async dispose() {
      await signer.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function publicInvocation(
  kind: 1 | 1111,
  author: ReturnType<typeof localNip17Identity>,
  recipient: string,
) {
  const command = `/intake@nostr:${npubEncode(recipient)}`;
  const root = await author.sign({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipient]],
    content: command,
  });
  if (kind === 1) return root;
  return author.sign(
    commentReply(
      root,
      { id: root.id, kind: "1", author: root.pubkey },
      command,
    ),
  );
}

test("DM intake claims the canonical rumor once across concurrent wrappers and relay sources", async () => {
  const f = await fixture();
  const bot = f.make();
  const entered = deferred();
  const release = deferred();
  let middlewareCalls = 0;
  let handlerCalls = 0;
  let originalContext: Context | undefined;
  bot.use(async (ctx, next) => {
    originalContext = ctx;
    middlewareCalls++;
    entered.resolve();
    await release.promise;
    await next();
  });
  bot.handle((ctx) => {
    assert.equal(ctx, originalContext);
    handlerCalls++;
  });
  try {
    await bot.start();
    const input = rumor(
      f.sender.pubkey,
      bot.pubkey,
      "canonical synthetic receipt",
    );
    const copies = await Promise.all(
      relays.map(() =>
        wrap(input, f.sender, bot.pubkey, bot.pubkey, standardEnvelope),
      ),
    );
    assert.notEqual(copies[0].id, copies[1].id);
    assert.equal(
      await bot.receive(
        { ...structuredClone(copies[0]), sig: "0".repeat(128) },
        "live",
        { relay: relays[0] },
      ),
      false,
    );
    assert.deepEqual(
      persistedIds(f.database),
      [],
      "an unauthenticated wrapper cannot claim an input",
    );
    const delivery = Promise.all(
      copies.map((event, index) =>
        bot.receive(event, "live", { relay: relays[index] }),
      ),
    );
    const deadline = AbortSignal.timeout(4000);
    await Promise.race([
      entered.promise,
      new Promise<never>((_resolve, reject) => {
        deadline.addEventListener(
          "abort",
          () => reject(new Error("fixture did not reach middleware")),
          { once: true },
        );
      }),
    ]);
    assert.deepEqual(
      persistedIds(f.database),
      [input.id],
      "the canonical ID is already committed",
    );
    assert.equal(
      bot.getMessage(input.id),
      undefined,
      "nothing enters accepted history before middleware proceeds",
    );
    release.resolve();
    assert.deepEqual((await delivery).sort(), [false, true]);
    await bot.idle();
    assert.equal(middlewareCalls, 1);
    assert.equal(handlerCalls, 1);
    assert.equal(originalContext?.input.id, input.id);
    assert.deepEqual(
      bot.dmHistory(f.sender.pubkey).messages.map(({ id }) => id),
      [input.id],
    );
  } finally {
    release.resolve();
    await bot.close();
    await f.dispose();
  }
});

test("allowlist middleware consumes denied DM by ID without content, even after restart with a new allowlist", async () => {
  const f = await fixture();
  let bot = f.make();
  let calls = 0;
  let observed = 0;
  bot.use(allowlist([]));
  bot.handle(() => {
    calls++;
  });
  bot.observe(() => {
    observed++;
  });
  try {
    await bot.start();
    const secretText =
      "rejected plaintext must never be persisted from synthetic middleware intake";
    const input = rumor(f.sender.pubkey, bot.pubkey, secretText);
    const first = await wrap(
      input,
      f.sender,
      bot.pubkey,
      bot.pubkey,
      standardEnvelope,
    );
    assert.equal(await bot.receive(first, "live", { relay: relays[0] }), true);
    await bot.idle();
    assert.equal(bot.getMessage(input.id), undefined);
    assert.equal(bot.dmHistory(f.sender.pubkey).messages.length, 0);
    assert.deepEqual([calls, observed], [0, 0]);
    await bot.close();
    assert.equal(
      (await readFile(f.database)).includes(Buffer.from(secretText)),
      false,
    );

    bot = f.make();
    bot.use(allowlist([f.sender.pubkey]));
    bot.handle(() => {
      calls++;
    });
    await bot.start();
    const replay = await wrap(
      input,
      f.sender,
      bot.pubkey,
      bot.pubkey,
      standardEnvelope,
    );
    assert.notEqual(replay.id, first.id);
    assert.equal(
      await bot.receive(replay, "live", { relay: relays[1] }),
      false,
    );
    await bot.idle();
    assert.equal(calls, 0);
    assert.equal(bot.dmHistory(f.sender.pubkey).messages.length, 0);
  } finally {
    await bot.close();
    await f.dispose();
  }
});

test("a throwing DM handler reports its failure once and is never dispatched again after a database reopen", async () => {
  const f = await fixture();
  let bot = f.make();
  const failure = new Error("synthetic handler failure");
  const errors: unknown[] = [];
  let calls = 0;
  let originalContext: Context | undefined;
  bot.use(async (ctx, next) => {
    originalContext = ctx;
    await next();
  });
  bot.catch((error, ctx) => {
    assert.equal(ctx, originalContext);
    errors.push(error);
  });
  bot.handle(() => {
    calls++;
    throw failure;
  });
  try {
    await bot.start();
    const input = rumor(f.sender.pubkey, bot.pubkey, "throw only once");
    const delivery = () =>
      wrap(input, f.sender, bot.pubkey, bot.pubkey, standardEnvelope);
    assert.equal(
      await bot.receive(await delivery(), "live", { relay: relays[0] }),
      true,
    );
    await bot.idle();
    assert.deepEqual(errors, [failure]);
    await bot.close();
    bot = f.make();
    bot.handle(() => {
      calls++;
    });
    await bot.start();
    assert.equal(
      await bot.receive(await delivery(), "live", { relay: relays[1] }),
      false,
    );
    await bot.idle();
    assert.equal(calls, 1);
  } finally {
    await bot.close();
    await f.dispose();
  }
});

for (const kind of [1, 1111] as const) {
  test(`public kind ${kind} dispatches a signed event ID once across relay replays and restart, even when the handler throws`, async () => {
    const f = await fixture();
    let bot = f.make();
    const command = { command: "intake", scopes: [`kind:${kind}`] } as const;
    const failure = new Error("synthetic public command failure");
    const errors: unknown[] = [];
    let calls = 0;
    let originalContext: Context | undefined;
    bot.use(allowlist([f.sender.pubkey]));
    bot.use(async (ctx, next) => {
      originalContext = ctx;
      await next();
    });
    bot.catch((error, ctx) => {
      assert.equal(ctx, originalContext);
      errors.push(error);
    });
    bot.command(command, (ctx) => {
      assert.equal(ctx.input, originalContext?.input);
      calls++;
      throw failure;
    });
    try {
      await bot.start();
      const input = await publicInvocation(kind, f.sender, bot.pubkey);
      const delivery = await Promise.all(
        relays.map((relay) =>
          bot.receive(structuredClone(input), "live", { relay }),
        ),
      );
      assert.deepEqual(delivery.sort(), [false, true]);
      await bot.idle();
      assert.equal(originalContext?.input.id, input.id);
      assert.deepEqual(errors, [failure]);
      await bot.close();
      bot = f.make();
      bot.command(command, () => {
        calls++;
      });
      await bot.start();
      assert.equal(
        await bot.receive(structuredClone(input), "live", { relay: relays[1] }),
        false,
      );
      await bot.idle();
      assert.equal(calls, 1);
    } finally {
      await bot.close();
      await f.dispose();
    }
  });
}

test("DM history after activation dispatches once, while public relay history remains passive", async () => {
  const f = await fixture();
  const bot = f.make();
  let calls = 0;
  bot.use(async (_ctx, next) => {
    calls++;
    await next();
  });
  bot.command({ command: "intake", scopes: ["kind:1"] }, () => {});
  try {
    await bot.start();
    const input = rumor(
      f.sender.pubkey,
      bot.pubkey,
      "historical synthetic plaintext",
    );
    const note = await publicInvocation(1, f.sender, bot.pubkey);
    const inputs: [Event, Event][] = [
      [
        await wrap(input, f.sender, bot.pubkey, bot.pubkey, standardEnvelope),
        await wrap(input, f.sender, bot.pubkey, bot.pubkey, standardEnvelope),
      ],
      [note, structuredClone(note)],
    ];
    for (const [history, live] of inputs) {
      assert.equal(
        await bot.receive(history, "history", { relay: relays[0] }),
        true,
      );
      assert.equal(
        await bot.receive(live, "live", { relay: relays[1] }),
        false,
      );
    }
    await bot.idle();
    assert.equal(calls, 1);
    assert.equal(bot.getMessage(input.id)?.source, "history");
    assert.equal(bot.getMessage(note.id), undefined);
  } finally {
    await bot.close();
    await f.dispose();
  }
});
