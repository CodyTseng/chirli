import { localNip17Identity } from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSecretKey,
  sqliteMessageStorage,
  type Transport,
} from "../src/index.js";
import { SQLiteStorage } from "../src/storage-sqlite.js";
import { JsonMessageStorage } from "../examples/_json-storage.js";
import { JsonStorage } from "./json-storage.js";
import { MemoryRelay } from "../examples/_support.js";
import { storageContract } from "./storage-contract.js";
for (const [name, Adapter] of [
  ["SQLite", SQLiteStorage],
  ["custom JSON", JsonStorage],
] as const) {
  storageContract(name, async () => {
    const dir = await mkdtemp(join(tmpdir(), "chirli-contract-")),
      path = join(dir, "state");
    return {
      open: () => new Adapter(path),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  });
  test(`${name}: message storage ownership and internal rotation recovery after uncertain ACK`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "chirli-adapter-"));
    const path = join(dir, "core.sqlite"),
      relay = new MemoryRelay(),
      wire = relay.transport();
    const identity = localNip17Identity(),
      storageKey = generateSecretKey();
    const messageStorage =
      name === "SQLite"
        ? sqliteMessageStorage(join(dir, "messages.sqlite"))
        : new JsonMessageStorage(join(dir, "messages.json"));
    let failing = false;
    const transport: Transport = {
      ...wire,
      publish: async (relays, event) => {
        await wire.publish(relays, event);
        if (failing && event.kind === 10044) throw new Error("ACK lost");
      },
    };
    const open = (transport: Transport) =>
      new Client({
        mode: "nip4e",
        identity,
        storageKey,
        database: path,
        messageStorage,
        relays: ["ws://demo.invalid"],
        transport,
      });
    let client = open(transport);
    try {
      await client.announce();
      const old = client.encryptionKeys().currentPublicKey;
      const adapter = Reflect.get(client.store, "adapter") as SQLiteStorage;
      const persist = adapter.setKeyring.bind(adapter);
      let diskFailure = true;
      adapter.setKeyring = (...args) => {
        if (diskFailure) throw new Error("adapter disk failure");
        persist(...args);
      };
      await assert.rejects(
        client.rotateEncryptionKey(),
        /adapter disk failure/,
      );
      assert.equal(client.encryptionKeys().currentPublicKey, old);
      assert.equal(client.encryptionKeys().pending, undefined);
      diskFailure = false;
      failing = true;
      await assert.rejects(client.rotateEncryptionKey(), /ACK lost/);
      const pending = client.encryptionKeys().pending;
      assert.ok(pending);
      await client.close();
      assert.throws(
        () => adapter.getKeyring(identity.pubkey),
        /closed|not open/i,
      );
      assert.doesNotThrow(() => messageStorage.query(identity.pubkey));
      failing = false;
      client = open(relay.transport());
      await client.start();
      assert.equal(client.encryptionKeys().currentPublicKey, pending.publicKey);
      assert.equal(client.encryptionKeys().pending, undefined);
      assert.equal(client.encryptionKeys().legacy[0].publicKey, old);
      const encryptionKey: unknown = Reflect.get(
        client,
        "account",
      ).encryptionKey;
      assert.ok(encryptionKey instanceof Uint8Array);
      const secret = Buffer.from(encryptionKey);
      await client.close();
      const file = await readFile(path);
      assert.ok(!file.includes(secret));
      assert.ok(!file.includes(Buffer.from(secret.toString("hex"))));
    } finally {
      await client.close();
      if ("close" in messageStorage) messageStorage.close();
      wire.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("internal storage replacement is rejected even by the private constructor", () => {
  assert.throws(
    () =>
      new Client({
        identity: localNip17Identity(),
        storage: {},
        database: ":memory:",
      } as never),
    /database path/,
  );
});

test("custom adapter refuses corrupt/future schemas without replacing the stored file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chirli-custom-schema-")),
    path = join(directory, "state.json");
  try {
    const adapter = new JsonStorage(path);
    adapter.setCheckpoint("account", "relay", 1);
    adapter.close();
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const document of [
      { ...original, schema: 2 },
      { ...original, keyrings: [] },
      { ...original, messages: null },
    ]) {
      const bytes = JSON.stringify(document);
      await writeFile(path, bytes);
      assert.throws(() => new JsonStorage(path));
      assert.equal(await readFile(path, "utf8"), bytes);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
