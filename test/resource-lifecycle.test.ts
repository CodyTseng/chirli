import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, nsecSigner, type Transport } from "../src/index.js";
import { Client } from "../src/client.js";
import type { SQLiteStorage } from "../src/storage-sqlite.js";

function transport(onClose: () => void): Transport {
	return {
		query: async () => [],
		publish: async () => {},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close: onClose,
	};
}

test("Client closes its own transport and database exactly once", async () => {
	const signer = nsecSigner(generateSecretKey());
	const client = await Client.create({ signer, database: ":memory:" });
	const wire: Transport = Reflect.get(client, "transport");
	const storage: SQLiteStorage = Reflect.get(
		Reflect.get(client, "coreStore"),
		"adapter",
	);
	const messages = Reflect.get(
		Reflect.get(client, "coreStore"),
		"messageStorage",
	);
	let connectionsClosed = 0,
		databasesClosed = 0,
		messagesClosed = 0;
	const closeMessages = messages.close.bind(messages);
	messages.close = () => {
		messagesClosed++;
		closeMessages();
	};
	const closeTransport = wire.close.bind(wire),
		closeStorage = storage.close.bind(storage);
	wire.close = () => {
		connectionsClosed++;
		closeTransport();
	};
	storage.close = () => {
		databasesClosed++;
		closeStorage();
	};
	try {
		await Promise.all([client.close(), client.close()]);
		await client.close();
		assert.equal(connectionsClosed, 1);
		assert.equal(databasesClosed, 1);
		assert.equal(messagesClosed, 1);
		assert.equal(await signer.getPublicKey(), client.pubkey);
	} finally {
		await client.close();
		await signer.close();
	}
});

test("shared injected resources remain usable after Client closure and failed construction", async () => {
	const signer = nsecSigner(generateSecretKey()),
		messageStorage = {
			insert() {
				return true;
			},
			query() {
				return [];
			},
			updateState() {},
		};
	let closed = 0;
	const wire = transport(() => {
		closed++;
	});
	const options = {
		signer,
		messageStorage,
		database: ":memory:",
		transport: wire,
	};
	const first = await Client.create(options),
		second = await Client.create(options);
	try {
		await first.close();
		assert.equal(closed, 0);
		second.setSession(second.pubkey, { active: true });
		assert.deepEqual(second.getSession(second.pubkey), { active: true });
		await second.close();
		assert.equal(closed, 0);
		assert.deepEqual(messageStorage.query(), []);

		await assert.rejects(
			Client.create({ ...options, metadataCache: { maxEntries: 0 } }),
			/maxEntries/,
		);
		assert.equal(closed, 0);
		assert.deepEqual(messageStorage.query(), []);
		assert.equal(await signer.getPublicKey(), first.pubkey);
	} finally {
		await first.close();
		await second.close();
		wire.close();
		await signer.close();
	}
	assert.equal(closed, 1);
});
