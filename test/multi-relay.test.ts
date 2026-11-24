import { z } from "zod";
import { localNip17Identity } from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { generateSecretKey, WebSocketTransport } from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { rumor, standardEnvelope, wrap } from "../src/protocol.js";
import { testRelay } from "./relay.js";
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("timeout");
}
async function unusedURL() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `ws://127.0.0.1:${port}`;
}
for (const mode of ["nip17", "nip4e"] as const) {
  test(`${mode}: two relay declarations, routing, duplicate delivery and partial/all ACK failures`, async () => {
    const first = await testRelay(),
      second = await testRelay(),
      relays = [first.url, second.url],
      identity = localNip17Identity(),
      peerIdentity = localNip17Identity();
    const service = new Client({
        mode,
        identity,
        relays,
        transport: new WebSocketTransport(500, (t) => identity.sign(t)),
        database: ":memory:",
        storageKey: generateSecretKey(),
      }),
      peer = new Client({
        identity: peerIdentity,
        relays,
        transport: new WebSocketTransport(500, (t) => peerIdentity.sign(t)),
        database: ":memory:",
        storageKey: generateSecretKey(),
      });
    const bot = new Bot(service);
    let commands = 0,
      replies = 0;
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
      async (ctx) => {
        commands++;
        await ctx.reply("pong");
      },
    );
    peer.handle(() => {
      replies++;
    });
    try {
      await service.announce();
      await peer.announce();
      await until(() =>
        [first, second].every((relay) =>
          [...relay.events.values()].some(
            (e) => e.kind === 10050 && e.pubkey === identity.pubkey,
          ),
        ),
      );
      for (const relay of [first, second]) {
        const list = [...relay.events.values()].find(
          (e) => e.kind === 10050 && e.pubkey === identity.pubkey,
        );
        assert.ok(list);
        assert.deepEqual(
          list.tags.map((t) => t[1]),
          relays,
        );
      }
      await bot.start();
      await peer.start();
      const sent = await peer.send(identity.pubkey, "/ping");
      assert.equal(sent.status, "relay-accepted");
      await until(() => replies === 1);
      await service.idle();
      await peer.idle();
      assert.equal(commands, 1);
      const wraps = [...first.events.values()].filter((e) => e.kind === 1059);
      await until(() => wraps.every((e) => second.events.has(e.id)));
      assert.equal(
        service
          .history(peerIdentity.pubkey)
          .messages.filter((m) => m.id === sent.id).length,
        1,
      );
      second.reject(true);
      const partial = await peer.send(identity.pubkey, "one ACK is enough");
      assert.equal(partial.status, "relay-accepted");
      first.reject(true);
      const pending = await peer.send(identity.pubkey, "all targets reject");
      assert.equal(pending.status, "pending");
      const queued = peer.store.outbox()[0];
      assert.equal(queued.id, pending.id);
      assert.ok(queued.events.every((e) => e.relays.length === 2));
      const ids = queued.events.map((e) => e.event.id);
      first.reject(false);
      await peer.flushOutbox();
      assert.equal(peer.store.outbox().length, 0);
      assert.ok(ids.every((id) => first.events.has(id)));
      const history = await service.syncHistory();
      assert.deepEqual(new Set(history.map((r) => r.relay)), new Set(relays));
      assert.ok(history.every((r) => r.status === "window-complete"));
      await service.idle();
      assert.equal(
        commands,
        1,
        "replayed overlap from both relays cannot rerun a command",
      );
    } finally {
      await bot.client.close();
      bot.dispose();
      await peer.close();
      await first.close();
      await second.close();
    }
  });
}

test("one unavailable discovery/inbox relay does not prevent a healthy replica; all discovery failure still rejects", async () => {
  const healthy = await testRelay(),
    offline = await unusedURL(),
    identity = localNip17Identity(),
    wire = new WebSocketTransport(150, (t) => identity.sign(t));
  const relays = [offline, healthy.url],
    client = new Client({
      identity,
      relays,
      transport: wire,
      database: ":memory:",
      storageKey: generateSecretKey(),
      recovery: false,
      reconnect: { initialDelayMs: 30, maxDelayMs: 60, jitter: 0 },
    }),
    errors: unknown[] = [];
  client.onError((e) => {
    errors.push(e);
  });
  try {
    await client.announce();
    await client.start();
    assert.ok(errors.length > 0);
    const metadata = await wire.query(relays, {
      kinds: [10050],
      authors: [identity.pubkey],
    });
    assert.equal(metadata.length, 1);
    await assert.rejects(wire.query([offline], { kinds: [10050] }));
    assert.deepEqual(
      await wire.query([healthy.url], { kinds: [42] }),
      [],
      "successful empty view is distinct from total failure",
    );
    const claim = [...healthy.events.values()].find((e) => e.kind === 10044);
    assert.ok(claim);
    assert.equal(claim.tags[0][1], identity.pubkey);
  } finally {
    await client.close();
    await healthy.close();
  }
});

test("initially unavailable replica retries independently and dispatches the recovered DM command once", async () => {
  const first = await testRelay(),
    second = await testRelay(),
    relays = [first.url, second.url],
    identity = localNip17Identity(),
    sender = localNip17Identity(),
    wire = new WebSocketTransport(500);
  const client = new Client({
    identity,
    relays,
    transport: new WebSocketTransport(500, (t) => identity.sign(t)),
    database: ":memory:",
    storageKey: generateSecretKey(),
    reconnect: { initialDelayMs: 40, maxDelayMs: 60, jitter: 0 },
  });
  const bot = new Bot(client);
  let calls = 0;
  bot.command({ command: "missed", scopes: ["kind:14"] }, () => {
    calls++;
  });
  client.onError(() => {});
  try {
    await client.announce();
    second.pauseReads(true);
    await bot.start();
    const missed = rumor(sender.pubkey, identity.pubkey, "/missed"),
      old = await wrap(
        missed,
        sender,
        identity.pubkey,
        identity.pubkey,
        standardEnvelope,
      );
    await wire.publish([second.url], old);
    second.pauseReads(false);
    await until(() => (client.store.checkpoint(second.url) ?? 0) > 0);
    await client.idle();
    assert.equal(calls, 1);
    assert.deepEqual(
      client
        .history(sender.pubkey)
        .messages.map(({ id, source }) => [id, source]),
      [[missed.id, "history"]],
    );
    const results = await client.syncHistory();
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === "window-complete"));
    assert.ok(client.store.checkpoint(first.url));
    assert.ok(client.store.checkpoint(second.url));
    // Rewrap the already recovered rumor through another live replica: dedup still wins.
    const duplicate = await wrap(
      missed,
      sender,
      identity.pubkey,
      identity.pubkey,
      standardEnvelope,
    );
    assert.equal(
      await client.receive(duplicate, "live", { relay: first.url }),
      false,
    );
    await client.idle();
    assert.equal(calls, 1);
  } finally {
    bot.dispose();
    await client.close();
    wire.close();
    await first.close();
    await second.close();
  }
});
