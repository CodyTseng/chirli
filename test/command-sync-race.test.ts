import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Bot,
  generateSecretKey,
  nsecSigner,
  type Transport,
} from "../src/index.js";
import { localNip17Identity } from "../src/protocol.js";
import { MemoryRelay } from "../examples/_support.js";
import { npubEncode } from "nostr-tools/nip19";
import { commentReply } from "../src/public-thread.js";
const urls = ["ws://revision-memory.invalid"];
for (const initial of [false, true])
  test(`merged command synchronization includes registrations during EOSE (${initial ? "existing public inbox" : "first public kind"})`, async () => {
    const network = new MemoryRelay(),
      wire = network.transport(),
      filters: number[][] = [];
    let block = false,
      entered!: () => void,
      release!: () => void,
      calls = 0;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const transport: Transport = {
      ...wire,
      subscribe: (relays, filter, receive, disconnect) => {
        const sub = wire.subscribe(relays, filter, receive, disconnect);
        if (filter.kinds?.some((kind) => [1, 1111].includes(kind))) {
          filters.push([...filter.kinds]);
          if (block) {
            block = false;
            entered();
            return {
              close: () => sub.close(),
              ready: gate.then(() => sub.ready),
            };
          }
        }
        return sub;
      },
    };
    const bot = new Bot({
      signer: nsecSigner(generateSecretKey()),
      database: ":memory:",
      relays: urls,
      transport,
      publicInbox: { relays: urls },
    });
    if (initial)
      bot.command({ command: "initial", scopes: ["kind:1"] }, () => {});
    try {
      await bot.start();
      block = true;
      const firstKind = initial ? 1111 : 1,
        secondKind = initial ? 1 : 1111;
      bot.command(
        { command: "first", scopes: [`kind:${firstKind}`] },
        () => {},
      );
      const first = bot.syncCommands();
      await waiting;
      bot.command({ command: "second", scopes: [`kind:${secondKind}`] }, () => {
        calls++;
      });
      const second = bot.syncCommands();
      assert.equal(first, second);
      let complete = false;
      void second.then(() => {
        complete = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(complete, false);
      release();
      const result = await second;
      assert.deepEqual(result, {
        added: ["first", "second"],
        updated: [],
        removed: [],
      });
      const catalog = await bot.discoverCommands({
        authors: [bot.pubkey],
        relays: urls,
      });
      assert.deepEqual(
        catalog.commands.map((item) => item.definition.command).sort(),
        initial ? ["first", "initial", "second"] : ["first", "second"],
      );
      const lastFilter = filters.at(-1);
      assert.ok(lastFilter);
      assert.deepEqual(
        lastFilter.sort((a, b) => a - b),
        [1, 1111],
      );
      const author = localNip17Identity(),
        root = await author.sign({
          kind: 1,
          created_at: 1,
          tags: [],
          content: "root",
        }),
        content = `/second@${npubEncode(bot.pubkey)}`;
      const event = await author.sign(
        secondKind === 1
          ? { kind: 1, created_at: 2, tags: [], content }
          : commentReply(
              root,
              { id: root.id, kind: "1", author: root.pubkey },
              content,
            ),
      );
      await wire.publish(urls, event);
      await bot.idle();
      assert.equal(
        calls,
        1,
        "latest kind is actually subscribed without another synchronization",
      );
    } finally {
      release();
      await bot.close();
      wire.close();
    }
  });

test("stop cancels the coalesced EOSE synchronization without reopening subscriptions", async () => {
  const network = new MemoryRelay(),
    wire = network.transport();
  let entered!: () => void,
    release!: () => void,
    publicSubscriptions = 0;
  const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const transport: Transport = {
    ...wire,
    subscribe: (relays, filter, receive, disconnect) => {
      const sub = wire.subscribe(relays, filter, receive, disconnect);
      if (filter.kinds?.includes(1)) {
        publicSubscriptions++;
        entered();
        return { close: () => sub.close(), ready: gate.then(() => sub.ready) };
      }
      return sub;
    },
  };
  const bot = new Bot({
    signer: nsecSigner(generateSecretKey()),
    database: ":memory:",
    relays: urls,
    transport,
    publicInbox: { relays: urls },
  });
  try {
    await bot.start();
    bot.command({ command: "first", scopes: ["kind:1"] }, () => {});
    const sync = bot.syncCommands(),
      rejected = assert.rejects(sync, /synchronization canceled/);
    await waiting;
    bot.command({ command: "second", scopes: ["kind:1111"] }, () => {});
    await bot.stop();
    await rejected;
    assert.equal(publicSubscriptions, 1);
  } finally {
    release();
    await bot.close();
    wire.close();
  }
});
