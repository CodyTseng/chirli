import { z } from "zod";
import { localNip17Identity } from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEvent, type Event } from "nostr-tools";
import {
	generateSecretKey,
	nsecSigner,
	DEFAULT_DISCOVERY_RELAYS,
	DEFAULT_READ_RELAYS,
	DEFAULT_WRITE_RELAYS,
	type Transport,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { readWriteTags, relayRoles } from "../src/relay-roles.js";
import { configuration } from "../examples/live/config.js";
import { testRelay } from "./relay.js";
async function waitForKinds(events: Map<string, Event>, kinds: number[]) {
	const deadline = Date.now() + 1000;
	while (
		!kinds.every((kind) =>
			[...events.values()].some((event) => event.kind === kind),
		)
	) {
		if (Date.now() > deadline)
			throw new Error("Missing discovery announcements");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
test("read/write defaults, role overrides and canonical NIP-65 tags", () => {
	const expected = [
		"wss://nos.lol/",
		"wss://relay.primal.net/",
		"wss://relay.ditto.pub/",
		"wss://offchain.pub/",
	];
	assert.deepEqual(DEFAULT_READ_RELAYS, expected);
	assert.deepEqual(DEFAULT_WRITE_RELAYS, expected);
	assert.deepEqual(DEFAULT_DISCOVERY_RELAYS, expected);
	assert.deepEqual(relayRoles({}).discoveryRelays, expected);
	assert.deepEqual(configuration({}).discoveryRelays, expected);
	assert.deepEqual(relayRoles({ relays: ["ws://local.invalid"] }), {
		dmRelays: ["ws://local.invalid"],
		readRelays: ["ws://local.invalid"],
		writeRelays: ["ws://local.invalid"],
		discoveryRelays: ["ws://local.invalid"],
	});
	assert.deepEqual(
		readWriteTags(
			["wss://shared.invalid", "wss://read.invalid"],
			["wss://shared.invalid/", "wss://write.invalid"],
		),
		[
			["r", "wss://shared.invalid/"],
			["r", "wss://read.invalid/", "read"],
			["r", "wss://write.invalid/", "write"],
		],
	);
	assert.throws(() => relayRoles({ writeRelays: [] }));
	assert.deepEqual(relayRoles({ readRelays: [] }).readRelays, []);
	const cfg = configuration({
		CHIRLI_RELAYS: "ws://common.invalid",
		CHIRLI_DM_RELAYS: "ws://dm.invalid",
		CHIRLI_READ_RELAYS: "",
		CHIRLI_WRITE_RELAYS: "ws://write.invalid",
	});
	assert.deepEqual(
		[cfg.relays, cfg.readRelays, cfg.writeRelays],
		[["ws://dm.invalid"], [], ["ws://write.invalid"]],
	);
});
for (const mode of ["nip17", "nip4e"] as const)
	test(`${mode}: start auto-publishes commands and role metadata to distinct local relays`, async () => {
		const dm = await testRelay(),
			read = await testRelay(),
			write = await testRelay(),
			discover = await testRelay(),
			identity = localNip17Identity();
		const client = new Client({
				identity,
				mode,
				database: ":memory:",
				dmRelays: [dm.url],
				readRelays: [read.url],
				writeRelays: [write.url],
				discoveryRelays: [discover.url],
			}),
			bot = new Bot(client);
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
			{ title: "Ping", description: "Reply pong." },
		);
		try {
			await bot.start();
			const events = [...write.events.values()];
			assert.deepEqual(new Set(events.map((e) => e.kind)), new Set([31992]));
			for (const e of events) {
				assert.ok(verifyEvent(e));
				assert.equal(e.pubkey, identity.pubkey);
			}
			assert.deepEqual(
				new Set([...dm.events.values()].map((e) => e.kind)),
				new Set([]),
			);
			assert.equal(read.events.size, 0);

			const command = events.find((e) => e.kind === 31992);
			assert.ok(command);
			assert.equal(command.tags.find((t) => t[0] === "d")?.[1], "ping");
			await client.announce();
			assert.deepEqual(
				[...write.events.values()].map((e) => e.kind).sort((a, b) => a - b),
				[10002, 10044, 10050, 10063, 31992],
				"explicit announce adds account metadata without duplicating commands",
			);
			assert.deepEqual(
				[...dm.events.values()].map((e) => e.kind).sort((a, b) => a - b),
				[10044, 10050],
			);
			await waitForKinds(discover.events, [10002, 10050, 10063]);
			assert.deepEqual(
				[...discover.events.values()].map((e) => e.kind).sort((a, b) => a - b),
				[10002, 10050, 10063],
			);
			assert.equal(read.events.size, 0);
		} finally {
			await bot.client.close();
			bot.dispose();
			await Promise.all([
				dm.close(),
				read.close(),
				write.close(),
				discover.close(),
			]);
		}
	});
function fixture() {
	const calls: { urls: string[]; event: Event }[] = [];
	let fail = false;
	const transport: Transport = {
		query: async () => [],
		publish: async (urls, event) => {
			calls.push({ urls: [...urls], event });
			if (fail && urls.includes("ws://write.invalid"))
				throw new Error("offline");
		},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
	};
	return {
		calls,
		transport,
		set fail(value: boolean) {
			fail = value;
		},
	};
}
test("key publication requires both role groups and retries the exact staged declaration", async () => {
	const f = fixture(),
		client = new Client({
			identity: localNip17Identity(),
			database: ":memory:",
			transport: f.transport,
			dmRelays: ["ws://dm.invalid"],
			writeRelays: ["ws://write.invalid"],
			readRelays: [],
		});
	try {
		f.fail = true;
		await assert.rejects(client.announce());
		assert.ok(client.encryptionKeys().pending);
		const id = f.calls[0].event.id;
		f.fail = false;
		await client.flushAnnouncements();
		assert.equal(client.encryptionKeys().pending, undefined);
		assert.ok(
			f.calls.some(
				(c) => c.urls.includes("ws://dm.invalid") && c.event.id === id,
			),
		);
		assert.equal(
			new Set(
				f.calls.filter((c) => c.event.kind === 10044).map((c) => c.event.id),
			).size,
			1,
		);
	} finally {
		await client.close();
	}
});
test("split rotation cannot activate before both write and DM publication groups accept", async () => {
	const f = fixture(),
		client = new Client({
			mode: "nip4e",
			identity: localNip17Identity(),
			database: ":memory:",
			transport: f.transport,
			dmRelays: ["ws://dm.invalid"],
			writeRelays: ["ws://write.invalid"],
			readRelays: [],
		});
	const original = f.transport.publish;
	try {
		await client.announce();
		const old = client.encryptionKeys().currentPublicKey;
		f.transport.publish = async (urls, event) => {
			if (urls.includes("ws://dm.invalid") && event.kind === 10044)
				throw new Error("DM group offline");
			await original(urls, event);
		};
		await assert.rejects(client.rotateEncryptionKey());
		const status = client.encryptionKeys();
		assert.equal(status.currentPublicKey, old);
		assert.ok(status.pending);
		assert.ok(status.decryptionPublicKeys.includes(status.pending.publicKey));
		const pending = status.pending;
		f.transport.publish = original;
		await client.flushAnnouncements();
		assert.equal(client.encryptionKeys().currentPublicKey, pending.publicKey);
		assert.equal(client.encryptionKeys().pending, undefined);
		assert.equal(
			new Set(
				f.calls
					.filter(
						(c) =>
							c.event.kind === 10044 &&
							c.event.tags[0][1] === pending.publicKey,
					)
					.map((c) => c.event.id),
			).size,
			1,
		);
	} finally {
		await client.close();
	}
});

test("a discovery ACK cannot replace write or DM ACKs, and only failed groups survive restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "chirli-announcements-"));
	const database = join(directory, "bot.sqlite"),
		signer = nsecSigner(generateSecretKey());
	const write = "ws://write.invalid/",
		dm = "ws://dm.invalid/",
		discovery = "ws://discovery.invalid/";
	const calls: { kind: number; id: string; urls: string[] }[] = [];
	let rejectRequired = true;
	const transport: Transport = {
		query: async () => [],
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
		publish: async (urls, event) => {
			if (![10002, 10050, 10063].includes(event.kind)) return;
			calls.push({ kind: event.kind, id: event.id, urls: [...urls] });
			if (
				rejectRequired &&
				((event.kind === 10002 && urls.includes(write)) ||
					(event.kind === 10050 && urls.includes(dm)))
			) {
				throw new Error("Required relay rejected");
			}
		},
	};
	const open = () =>
		Client.create({
			signer,
			database,
			transport,
			dmRelays: [dm],
			readRelays: [],
			writeRelays: [write],
			discoveryRelays: [write.slice(0, -1), discovery, discovery.slice(0, -1)],
		});
	let client = await open();
	try {
		await assert.rejects(
			client.announce(),
			(error: unknown) =>
				error instanceof AggregateError && error.errors.length === 2,
		);
		const destinations = (kind: number) =>
			calls
				.filter((call) => call.kind === kind)
				.flatMap((call) => call.urls)
				.sort();
		assert.deepEqual(destinations(10002), [discovery, write]);
		assert.deepEqual(destinations(10050), [discovery, dm, write]);
		assert.deepEqual(destinations(10063), [discovery, write]);
		const failed = calls.filter(
			(call) =>
				(call.kind === 10002 && call.urls.includes(write)) ||
				(call.kind === 10050 && call.urls.includes(dm)),
		);

		await client.close();
		rejectRequired = false;
		calls.length = 0;
		client = await open();
		await client.start(true);
		assert.deepEqual(
			calls,
			failed,
			"restart retries just the failed required destinations with the original signed IDs",
		);
		await client.flushAnnouncements();
		assert.deepEqual(calls, failed, "completed work is not retried");
	} finally {
		await client.close();
		await signer.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("discovery failure or a slow discovery attempt cannot block readiness or queue retries", async () => {
	const write = "ws://write.invalid/",
		dm = "ws://dm.invalid/",
		discovery = "ws://discovery.invalid/";
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const discoveryKinds: number[] = [];
	const transport: Transport = {
		query: async () => [],
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
		publish: async (urls, event) => {
			if (!urls.includes(discovery)) return;
			discoveryKinds.push(event.kind);
			if (event.kind === 10063) await held;
			throw new Error("Optional discovery relay rejected");
		},
	};
	const signer = nsecSigner(generateSecretKey());
	const client = await Client.create({
		signer,
		database: ":memory:",
		transport,
		dmRelays: [dm],
		readRelays: [],
		writeRelays: [write],
		discoveryRelays: [discovery],
	});
	try {
		await client.start(true);
		await client.flushAnnouncements();
		assert.deepEqual(discoveryKinds, [10002, 10050, 10063]);
	} finally {
		release();
		await client.close();
		await signer.close();
	}
});
