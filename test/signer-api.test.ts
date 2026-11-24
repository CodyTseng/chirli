import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nsecSigner,
  bunkerSigner,
  generateSecretKey,
  type Signer,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { Client } from "../src/client.js";
import { MemoryRelay } from "../examples/_support.js";

for (const mode of ["nip17", "nip4e"] as const)
  for (const delayed of [false, true]) {
    test(`${mode}: business API is identical for local and asynchronously delegated signers (${delayed})`, async () => {
      const relay = new MemoryRelay(),
        local = nsecSigner(generateSecretKey());
      const calls: string[] = [];
      // A remote capability delegates the same interface; Client never inspects its backend.
      const signer: Signer = delayed
        ? {
            getPublicKey: async () => {
              calls.push("publicKey");
              await Promise.resolve();
              return local.getPublicKey();
            },
            signEvent: async (template) => {
              calls.push("sign");
              await Promise.resolve();
              return local.signEvent(template);
            },
            nip44Encrypt: async (peer, text) => {
              calls.push("encrypt");
              return local.nip44Encrypt(peer, text);
            },
            nip44Decrypt: async (peer, text) => {
              calls.push("decrypt");
              return local.nip44Decrypt(peer, text);
            },
            close: () => local.close(),
          }
        : local;
      const service = await Client.create({
        signer,
        mode,
        transport: relay.transport(),
        relays: ["ws://memory.invalid"],
        database: ":memory:",
      });
      const peerSigner = nsecSigner(generateSecretKey());
      const peer = await Client.create({
        signer: peerSigner,
        mode,
        transport: relay.transport(),
        relays: ["ws://memory.invalid"],
        database: ":memory:",
      });
      const bot = new Bot(service);
      const replies: string[] = [];
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
          await ctx.reply("pong");
        },
        {},
      );
      peer.on("message", (message) => {
        replies.push(message.text);
      });
      try {
        assert.equal(service.pubkey, await signer.getPublicKey());
        await service.announce();
        await peer.announce();
        await service.start();
        await peer.start();
        const sent = await peer.send(service.pubkey, "/ping");
        await service.idle();
        await peer.idle();
        assert.equal(sent.status, "relay-accepted");
        assert.deepEqual(replies, ["pong"]);
        assert.equal(service.getMessageState(sent.id), "done");
        if (delayed) {
          assert.ok(calls.includes("sign"));
          assert.ok(calls.includes("publicKey"));
        }
        await service.close();
        assert.equal(
          await signer.getPublicKey(),
          service.pubkey,
          "injected signer is borrowed",
        );
      } finally {
        bot.dispose();
        await service.close();
        await peer.close();
        await peerSigner.close();
        await signer.close?.();
      }
    });
  }

test("signer ownership, failed account resolution and credential isolation are explicit", async () => {
  const bytes = generateSecretKey(),
    signer = nsecSigner(bytes),
    account = await signer.getPublicKey();
  const client = await Client.create({ signer, database: ":memory:" });
  assert.equal(client.pubkey, account);
  assert.ok(
    !JSON.stringify(signer).includes(Buffer.from(bytes).toString("hex")),
  );
  await Promise.all([client.close(), client.close()]);
  assert.equal(await signer.getPublicKey(), account);
  await signer.close();
  await assert.rejects(signer.getPublicKey(), /SIGNER_CLOSED/);
  const independent = nsecSigner(bytes);
  assert.equal(await independent.getPublicKey(), account);
  await independent.close();
  let closes = 0;
  const unavailable: Signer = {
    getPublicKey: async () => {
      throw new Error("unavailable");
    },
    signEvent: async () => {
      throw new Error("unused");
    },
    nip44Encrypt: async () => "",
    nip44Decrypt: async () => "",
    close: async () => {
      closes++;
    },
  };
  await assert.rejects(
    Client.create({ signer: unavailable, database: ":memory:" }),
    /unavailable/,
  );
  assert.equal(closes, 0);
  assert.throws(
    () =>
      bunkerSigner("not a bunker URI", { clientSecret: generateSecretKey() }),
    /Invalid bunker/,
  );
});

test("custom capability signers need no lifecycle or NIP-04 methods; account resolution is cached", async () => {
  const local = nsecSigner(generateSecretKey());
  let resolutions = 0;
  const signer: Signer = {
    getPublicKey: async () => {
      resolutions++;
      return local.getPublicKey();
    },
    signEvent: (template) => local.signEvent(template),
    nip44Encrypt: (peer, text) => local.nip44Encrypt(peer, text),
    nip44Decrypt: (peer, text) => local.nip44Decrypt(peer, text),
  };
  const relay = new MemoryRelay();
  const client = await Client.create({
    signer,
    database: ":memory:",
    transport: relay.transport(),
  });
  try {
    const account = await local.getPublicKey();
    assert.equal(client.pubkey, account);
    assert.equal(client.pubkey, account);
    await client.announce();
    await client.start();
    await client.send(account, "self message");
    assert.equal(resolutions, 1);
    assert.equal(Object.hasOwn(client.options, "identity"), false);
    assert.equal(Object.hasOwn(client.options, "signer"), false);
    assert.equal("identity" in client, false);
  } finally {
    await client.close();
    await local.close();
  }
});

test("Client.create rejects identity input and incomplete signer capabilities before account resolution", async () => {
  const local = nsecSigner(generateSecretKey());
  try {
    await assert.rejects(
      Client.create({
        signer: local,
        identity: {},
        database: ":memory:",
      } as never),
      /accepts signer/,
    );
    await assert.rejects(
      Client.create({
        signer: { getPublicKey: () => local.getPublicKey() } as Signer,
        database: ":memory:",
      }),
      /signEvent/,
    );
  } finally {
    await local.close();
  }
});

test("local signers provide optional NIP-04 and preserve caller credentials on close", async () => {
  const secret = generateSecretKey(),
    original = new Uint8Array(secret);
  const alice = nsecSigner(secret),
    bob = nsecSigner(generateSecretKey());
  try {
    const ciphertext = await alice.nip04Encrypt(
      await bob.getPublicKey(),
      "hello",
    );
    assert.equal(
      await bob.nip04Decrypt(await alice.getPublicKey(), ciphertext),
      "hello",
    );
    await alice.close();
    assert.deepEqual(secret, original);
    await assert.rejects(
      alice.nip04Encrypt(await bob.getPublicKey(), "closed"),
      /SIGNER_CLOSED/,
    );
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("shared signers remain application-owned across client closure and failed construction", async () => {
  const local = nsecSigner(generateSecretKey());
  let closes = 0;
  const signer: Signer = {
    getPublicKey: () => local.getPublicKey(),
    signEvent: (template) => local.signEvent(template),
    nip44Encrypt: (peer, text) => local.nip44Encrypt(peer, text),
    nip44Decrypt: (peer, text) => local.nip44Decrypt(peer, text),
    close: async () => {
      closes++;
      await local.close();
    },
  };
  const relay = new MemoryRelay();
  const open = () =>
    Client.create({
      signer,
      database: ":memory:",
      transport: relay.transport(),
    });
  const first = await open(),
    second = await open();
  try {
    await first.close();
    await second.announce();
    await assert.rejects(
      Client.create({ signer, database: ":memory:", storage: {} } as never),
      /messageStorage/,
    );
    assert.equal(closes, 0);
    assert.equal(await signer.getPublicKey(), second.pubkey);
    await second.close();
    assert.equal(closes, 0);
  } finally {
    await first.close();
    await second.close();
    await signer.close?.();
  }
  assert.equal(closes, 1);
});
