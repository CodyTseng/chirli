import { z } from "zod";
import {
  localIdentity,
  localNip17Identity,
  standardEnvelope,
  wrap,
} from "../src/protocol.js";
import { identityFromSigner } from "../src/signers.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nip44, verifyEvent } from "nostr-tools";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";
import {
  bunkerSigner,
  nsecSigner,
  generateSecretKey,
  getPublicKey,
  SignerError,
  DEFAULT_RELAY_TIMEOUTS,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { mockBunker } from "./bunker.js";
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition timeout");
}

test("nsec signer validates input, signs, supports NIP-44 and closes without exposing the key", async () => {
  const secret = generateSecretKey(),
    nsec = nsecEncode(secret),
    signer = nsecSigner(nsec),
    peer = localNip17Identity();
  try {
    assert.equal(await signer.getPublicKey(), getPublicKey(secret));
    const event = await signer.signEvent({
      kind: 1,
      created_at: 10,
      tags: [],
      content: "disposable",
    });
    assert.ok(verifyEvent(event));
    const ciphertext = await signer.nip44Encrypt(peer.pubkey, "test message");
    assert.equal(
      nip44.v2.decrypt(
        ciphertext,
        nip44.v2.utils.getConversationKey(peer.encryptionKey, event.pubkey),
      ),
      "test message",
    );
    assert.equal(JSON.stringify(signer).includes(nsec), false);
    assert.throws(() => nsecSigner(npubEncode(peer.pubkey)), /Invalid nsec/);
    assert.throws(() => nsecSigner("not a secret"), /Invalid nsec/);
  } finally {
    await signer.close();
  }
  await assert.rejects(
    signer.getPublicKey(),
    (error) => error instanceof SignerError && error.code === "SIGNER_CLOSED",
  );
});

test("bunker uses one lazy handshake, resolves the user key and rejects URL challenges", async () => {
  const remote = await mockBunker();
  const signer = bunkerSigner(remote.uri, {
    clientSecret: generateSecretKey(),
    timeoutMs: 1000,
  });
  try {
    assert.equal(remote.methods.length, 0);
    const keys = await Promise.all([
      signer.getPublicKey(),
      signer.getPublicKey(),
      signer.getPublicKey(),
    ]);
    assert.ok(keys.every((key) => key === remote.accountPubkey));
    assert.notEqual(remote.accountPubkey, remote.transportPubkey);
    assert.equal(
      remote.methods.filter((method) => method === "connect").length,
      1,
    );
    assert.equal(
      remote.methods.filter((method) => method === "get_public_key").length,
      1,
    );
    const template = {
      kind: 1,
      created_at: 10,
      tags: [],
      content: "temporary",
    };
    remote.auth(true);
    await assert.rejects(
      signer.signEvent(template),
      (error: unknown) =>
        error instanceof SignerError &&
        error.code === "SIGNER_FAILED" &&
        !error.message.includes("authorize-disposable-session"),
    );
    remote.auth(false);
    assert.ok(verifyEvent(await signer.signEvent(template)));
    const peer = localNip17Identity(),
      encrypted = await signer.nip44Encrypt(peer.pubkey, "remote encryption");
    assert.equal(
      nip44.v2.decrypt(
        encrypted,
        nip44.v2.utils.getConversationKey(
          peer.encryptionKey,
          remote.accountPubkey,
        ),
      ),
      "remote encryption",
    );
    const forRemote = nip44.v2.encrypt(
      "remote decryption",
      nip44.v2.utils.getConversationKey(
        peer.encryptionKey,
        remote.accountPubkey,
      ),
    );
    assert.equal(
      await signer.nip44Decrypt(peer.pubkey, forRemote),
      "remote decryption",
    );
    remote.tamper(true);
    await assert.rejects(
      signer.signEvent({
        kind: 1,
        created_at: 10,
        tags: [],
        content: "must stay unchanged",
      }),
      SignerError,
    );
    assert.equal(JSON.stringify(signer).includes("disposable-token"), false);
  } finally {
    await signer.close();
    await remote.close();
  }
});

for (const mode of ["nip4e", "nip17"] as const) {
  test(`${mode}: bunker-backed SDK identity uses the shared Bot and authenticated message lifecycle`, async () => {
    const remote = await mockBunker(),
      signer = bunkerSigner(remote.uri, {
        clientSecret: generateSecretKey(),
        timeoutMs: 1000,
      });
    const identity =
      mode === "nip17"
        ? await identityFromSigner(signer, { mode })
        : await identityFromSigner(signer, {
            encryptionKey: generateSecretKey(),
          });
    const peer = mode === "nip17" ? localNip17Identity() : localIdentity();
    const client = new Client({
      mode,
      identity,
      relays: [remote.relay],
      database: ":memory:",
      storageKey: generateSecretKey(),
    });
    const user = new Client({
      mode,
      identity: peer,
      relays: [remote.relay],
      database: ":memory:",
      storageKey: generateSecretKey(),
    });
    const bot = new Bot(client);
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
        await ctx.reply("bunker pong");
      },
    );
    let reply = "";
    user.handle((message) => {
      reply = message.text;
    });
    try {
      await client.announce();
      await user.announce();
      await bot.start();
      await user.start();
      await user.send(identity.pubkey, "/ping");
      await until(() => reply !== "");
      await client.idle();
      await user.idle();
      assert.equal(reply, "bunker pong");
      if (mode === "nip17") {
        assert.equal(identity.encryptionKey, undefined);
        assert.ok(remote.methods.includes("nip44_decrypt"));
        assert.ok(remote.methods.includes("nip44_encrypt"));
        const before = remote.methods.length;
        const bogus = {
          kind: 1059,
          created_at: 10,
          pubkey: peer.pubkey,
          tags: [["p", identity.pubkey]],
          content: "bad",
          id: "0".repeat(64),
          sig: "0".repeat(128),
        };
        assert.equal(await client.receive(bogus, "live"), false);
        assert.equal(remote.methods.length, before);
      } else {
        assert.equal(remote.methods.includes("nip44_decrypt"), false);
        assert.equal(remote.methods.includes("nip44_encrypt"), false);
      }
      await bot.client.close();
      bot.dispose();
      assert.equal(
        await signer.getPublicKey(),
        remote.accountPubkey,
        "Client close does not destroy an externally owned signer",
      );
    } finally {
      await user.close();
      await bot.client.close();
      bot.dispose();
      await signer.close();
      await remote.close();
    }
  });
}

test("bunker timeouts discard stale connections, reconnect with the client session key and close pending requests", async () => {
  const remote = await mockBunker(),
    signer = bunkerSigner(remote.uri, {
      clientSecret: generateSecretKey(),
      timeoutMs: 100,
    });
  try {
    await signer.getPublicKey();
    remote.pause("sign_event");
    await assert.rejects(
      signer.signEvent({
        kind: 1,
        created_at: 10,
        tags: [],
        content: "timeout",
      }),
      (error) =>
        error instanceof SignerError && error.code === "SIGNER_TIMEOUT",
    );
    remote.pause();
    assert.equal(await signer.getPublicKey(), remote.accountPubkey);
    assert.equal(
      remote.methods.filter((method) => method === "connect").length,
      2,
    );
    remote.pause("sign_event");
    const pending = signer.signEvent({
      kind: 1,
      created_at: 10,
      tags: [],
      content: "closing",
    });
    await until(
      () =>
        remote.methods.filter((method) => method === "sign_event").length >= 2,
    );
    await signer.close();
    await assert.rejects(
      pending,
      (error) => error instanceof SignerError && error.code === "SIGNER_CLOSED",
    );
  } finally {
    await signer.close();
    await remote.close();
  }
});

test("bunker connects after the Bot transport default when timeoutMs allows it", async () => {
  const relayDefault = DEFAULT_RELAY_TIMEOUTS.connectionTimeoutMs;
  const remote = await mockBunker(relayDefault + 200);
  const signer = bunkerSigner(remote.uri, {
    clientSecret: generateSecretKey(),
    timeoutMs: relayDefault + 5000,
  });
  try {
    assert.equal(await signer.getPublicKey(), remote.accountPubkey);
  } finally {
    await signer.close();
    await remote.close();
  }
});

test("bunker switches to a relay without EOSE and releases both relay connections on timeout", async () => {
  const remote = await mockBunker();
  const signer = bunkerSigner(remote.uri, {
    clientSecret: generateSecretKey(),
    timeoutMs: 300,
  });
  const template = { kind: 1, created_at: 10, tags: [], content: "disposable" };
  try {
    const target = await remote.switchRelay();
    assert.equal(await signer.getPublicKey(), remote.accountPubkey);
    assert.equal(
      (await signer.signEvent(template)).pubkey,
      remote.accountPubkey,
    );
    assert.equal(target.activeConnections, 2);

    remote.pause("sign_event");
    await assert.rejects(signer.signEvent(template), {
      code: "SIGNER_TIMEOUT",
    });
    await until(
      () => remote.initialConnections === 1 && target.activeConnections === 1,
    );

    remote.pause();
    assert.equal(
      (await signer.signEvent(template)).pubkey,
      remote.accountPubkey,
    );
    assert.equal(target.activeConnections, 2);
    assert.equal(
      remote.methods.filter((method) => method === "connect").length,
      2,
    );
  } finally {
    await signer.close();
    await remote.close();
  }
});

test("pure remote decryption failures leave checkpoints unchanged and recover eligible history once", async (t) => {
  const remote = await mockBunker();
  let signer: ReturnType<typeof bunkerSigner> | undefined;
  let client: Client | undefined;
  let user: Client | undefined;
  t.after(async () => {
    const clients = await Promise.allSettled([client?.close(), user?.close()]);
    try {
      await signer?.close();
    } finally {
      await remote.close();
    }
    for (const result of clients)
      if (result.status === "rejected") throw result.reason;
  });

  signer = bunkerSigner(remote.uri, { clientSecret: generateSecretKey() });
  const identity = await identityFromSigner(signer, { mode: "nip17" });
  const peer = localNip17Identity();
  client = new Client({
    mode: "nip17",
    identity,
    relays: [remote.relay],
    database: ":memory:",
    storageKey: generateSecretKey(),
  });
  user = new Client({
    mode: "nip17",
    identity: peer,
    relays: [remote.relay],
    database: ":memory:",
    storageKey: generateSecretKey(),
  });
  let calls = 0;
  client.handle(() => {
    calls++;
  });
  client.onError(() => {});

  await client.announce();
  await user.announce();
  await client.start();
  await client.stop();
  const checkpoint = client.store.checkpoint(remote.relay);
  const sent = await user.send(identity.pubkey, "/missed after activation");
  const message = user.getMessage(sent.id);
  assert.ok(message);
  const original = message.rumor;
  const requestsBeforeRecovery = remote.methods.length;
  remote.reject("nip44_decrypt");
  await client.start();
  assert.ok(
    remote.methods.slice(requestsBeforeRecovery).includes("nip44_decrypt"),
  );
  assert.equal(client.store.checkpoint(remote.relay), checkpoint);

  remote.reject();
  const [result] = await client.syncHistory();
  assert.equal(result.status, "window-complete");
  await client.idle();
  assert.equal(calls, 1);
  assert.deepEqual(
    client
      .history(peer.pubkey)
      .messages.map((message) => [message.id, message.source]),
    [[sent.id, "history"]],
  );
  assert.equal(
    await client.receive(
      await wrap(
        original,
        peer,
        identity.pubkey,
        identity.pubkey,
        standardEnvelope,
      ),
      "live",
    ),
    false,
  );
  await client.idle();
  assert.equal(calls, 1);
});

test("bunkerSigner rejects invalid bunker connection URIs", () => {
  const clientSecret = generateSecretKey();
  assert.throws(
    () => bunkerSigner("someone@example.test", { clientSecret }),
    /Invalid bunker/,
  );
  assert.throws(
    () =>
      bunkerSigner("bunker://invalid?relay=https://example.test", {
        clientSecret,
      }),
    /Invalid bunker/,
  );
});

test("bunkerSigner requires an explicit valid client key before connecting", () => {
  const uri = `bunker://${getPublicKey(generateSecretKey())}?relay=ws://127.0.0.1:1`;
  // @ts-expect-error A JavaScript caller may omit options.
  assert.throws(() => bunkerSigner(uri), /clientSecret/);
  // @ts-expect-error A client key is required even when other options are set.
  assert.throws(() => bunkerSigner(uri, { timeoutMs: 100 }), /clientSecret/);
  assert.throws(
    () => bunkerSigner(uri, { clientSecret: new Uint8Array(31) }),
    /32-byte/,
  );
  assert.throws(
    () => bunkerSigner(uri, { clientSecret: new Uint8Array(32) }),
    /valid NIP-46/,
  );
});
