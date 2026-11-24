import { z } from "zod";
import {
	localIdentity,
	localNip17Identity,
	type LocalIdentity as Identity,
} from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	finalizeEvent,
	getEventHash,
	nip44,
	type Event,
	type Filter,
} from "nostr-tools";
import * as nip17 from "nostr-tools/nip17";
import {
	generateSecretKey,
	getPublicKey,
	type ProtocolMode,
	type Transport,
	WebSocketTransport,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { rumor, standardEnvelope, unwrap, wrap } from "../src/protocol.js";
import { testRelay } from "./relay.js";
const encrypt = (value: unknown, key: Uint8Array, peer: string) =>
	nip44.v2.encrypt(
		JSON.stringify(value),
		nip44.v2.utils.getConversationKey(key, peer),
	);
const decrypt = (value: string, key: Uint8Array, peer: string) =>
	JSON.parse(
		nip44.v2.decrypt(value, nip44.v2.utils.getConversationKey(key, peer)),
	);
async function until(fn: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.fail("condition timeout");
}
const options = (identity: Identity, relays = ["ws://unused.invalid"]) => ({
	mode: "nip4e" as const,
	identity,
	relays,
	storageKey: generateSecretKey(),
	database: ":memory:",
});

test("explicit mode configuration: default compatibility and unified-key validation", async () => {
	const identity = localIdentity();
	const client = new Client({
		...options(localNip17Identity()),
		mode: undefined,
	});
	assert.equal(client.mode, "nip17");
	assert.ok(client.store.account.startsWith("nip17:"));
	await client.close();
	assert.throws(
		() => new Client({ ...options(identity), mode: undefined }),
		/identity secret/,
	);
	assert.throws(
		() => new Client({ ...options(identity), mode: "nip17" }),
		/identity secret/,
	);
	const unified = localNip17Identity();
	const retained = new Client({
		...options({ ...unified, oldEncryptionKeys: [generateSecretKey()] }),
		mode: "nip17",
	});
	await retained.close();
	assert.throws(
		() => new Client({ ...options(unified), mode: "unknown" as ProtocolMode }),
		/Unsupported protocol mode/,
	);
});

test("standard NIP-17 interoperates both directions with independent nostr-tools helpers", async () => {
	const secret = generateSecretKey(),
		sender = localNip17Identity(secret),
		receiver = localNip17Identity();
	const external = nip17.wrapEvent(
		secret,
		{ publicKey: receiver.pubkey },
		"independent standard sender",
	);
	assert.equal(
		unwrap(external, receiver, standardEnvelope)?.rumor.content,
		"independent standard sender",
	);
	assert.equal(
		unwrap(external, receiver),
		undefined,
		"default must not accept standard envelopes",
	);
	const r = rumor(sender.pubkey, receiver.pubkey, "SDK standard sender");
	const event = await wrap(
		r,
		sender,
		receiver.pubkey,
		receiver.pubkey,
		standardEnvelope,
	);
	assert.deepEqual(nip17.unwrapEvent(event, receiver.encryptionKey), r);
	const seal = decrypt(
		event.content,
		receiver.encryptionKey,
		event.pubkey,
	) as Event;
	assert.deepEqual(seal.tags, []);
	assert.equal(seal.pubkey, sender.pubkey);
	const now = Math.floor(Date.now() / 1000);
	for (const time of [seal.created_at, event.created_at])
		assert.ok(time <= now && time >= now - 172800);
	assert.notEqual(event.pubkey, sender.pubkey);
	const split = await wrap(r, sender, receiver.pubkey, receiver.pubkey);
	assert.equal(
		unwrap(split, receiver, standardEnvelope),
		undefined,
		"no split-key downgrade even with identical keys",
	);
});

test("standard intake rejects signatures, authors, rumor hashes and recipients before exposing data", async () => {
	const sender = localNip17Identity(),
		receiver = localNip17Identity(),
		outsider = localNip17Identity();
	const r = rumor(sender.pubkey, receiver.pubkey, "strict", Date.now() + 1000);
	const envelope = async (
		payload: unknown,
		tags: string[][] = [],
		badSeal = false,
		routes = [receiver.pubkey],
	) => {
		let seal = await sender.sign({
			kind: 13,
			created_at: r.created_at - 10,
			tags,
			content: encrypt(payload, sender.encryptionKey, receiver.pubkey),
		});
		if (badSeal) seal = { ...seal, sig: "0".repeat(128) };
		const ephemeral = generateSecretKey();
		return finalizeEvent(
			{
				kind: 1059,
				created_at: r.created_at - 20,
				tags: routes.map((peer) => ["p", peer]),
				content: encrypt(seal, ephemeral, receiver.pubkey),
			},
			ephemeral,
		);
	};
	const rehash = (value: typeof r) => ({ ...value, id: getEventHash(value) });
	const invalid = [
		await envelope(r, [], true),
		await envelope({ ...r, id: "0".repeat(64) }),
		await envelope(rehash({ ...r, pubkey: outsider.pubkey })),
		await envelope(rehash({ ...r, tags: [["p", outsider.pubkey]] })),
		await envelope({ ...r, sig: "0".repeat(128) }),
		await envelope(r, [["n", "invalid"]]),
		await envelope(r, [], false, [outsider.pubkey]),
		await envelope(r, [], false, [receiver.pubkey, outsider.pubkey]),
	];
	const valid = await envelope(r);
	invalid.push({ ...valid, sig: "0".repeat(128) });
	const transport: Transport = {
		query: async () => [],
		publish: async () => {},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
	};
	const client = new Client({
		...options(receiver),
		mode: "nip17",
		nip4eCompatibility: false,
		transport,
	});
	try {
		await client.start();
		for (const event of invalid)
			assert.equal(await client.receive(event, "live"), false);
		assert.equal(client.history(sender.pubkey).messages.length, 0);
		assert.equal(await client.receive(valid, "history"), true);
	} finally {
		await client.close();
	}
});

test("identity-key discovery authenticates NIP-4E and uses own DM relay fallback for missing, forged or revoked relay lists", async () => {
	const identity = localNip17Identity(),
		peer = localNip17Identity(),
		outsider = localNip17Identity();
	const filters: Filter[] = [];
	let events: Event[] = [];
	const transport: Transport = {
		query: async (_relays, filter) => {
			filters.push(filter);
			return events;
		},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		publish: async () => {
			throw new Error("Must not publish when discovery is invalid");
		},
		close() {},
	};
	const client = new Client({
		...options(identity),
		mode: "nip17",
		metadataCache: false,
		nip4eCompatibility: false,
		transport,
	});
	const list = (author: Identity, tags: string[][], time = 10) =>
		author.sign({ kind: 10050, created_at: time, tags, content: "" });
	try {
		const n = await peer.sign({
			kind: 10044,
			created_at: 9999,
			tags: [["n", outsider.pubkey]],
			content: "",
		});
		const valid = await list(peer, [["relay", "ws://inbox.invalid"]]);
		for (const bad of [
			[],
			[n],
			[await list(outsider, [["relay", "ws://inbox.invalid"]])],
			[{ ...valid, sig: "0".repeat(128) }],
			[await list(peer, [["relay", "https://inbox.invalid"]])],
			[valid, await list(peer, [], 11)],
		]) {
			events = bad;
			const resolved = await client.refreshPeer(peer.pubkey);
			assert.deepEqual(resolved.relays, client.options.dmRelays);
			assert.equal(client.store.outbox().length, 0);
			assert.equal(client.history(peer.pubkey).messages.length, 0);
		}
		events = [await list(peer, [["relay", "ws://inbox.invalid"]], 12), n];
		assert.deepEqual(await client.refreshPeer(peer.pubkey), {
			encryptionPubkey: outsider.pubkey,
			relays: ["ws://inbox.invalid"],
		});
		assert.ok(filters.some((filter) => filter.kinds?.includes(10044)));
		assert.equal(client.store.evidence(peer.pubkey)?.key, outsider.pubkey);
	} finally {
		await client.close();
	}
});

for (const mode of ["nip4e", "nip17"] as const) {
	test(`${mode}: shared Bot/session/history/lifecycle and persistent outbox`, async () => {
		const relay = await testRelay(),
			dir = await mkdtemp(join(tmpdir(), `psst-${mode}-`));
		const identity = mode === "nip17" ? localNip17Identity : localIdentity;
		const a = identity(),
			b = identity(),
			aKey = generateSecretKey(),
			bKey = generateSecretKey();
		const aOptions = {
			...options(a, [relay.url]),
			mode,
			storageKey: aKey,
			database: join(dir, "a.sqlite"),
		};
		const bOptions = {
			...options(b, [relay.url]),
			mode,
			storageKey: bKey,
			database: join(dir, "b.sqlite"),
		};
		let alice = new Client(aOptions),
			bob = new Client(bOptions);
		try {
			await alice.announce();
			await bob.announce();
			await alice.send(b.pubkey, "/ping history");
			let calls = 0,
				fallback = 0;
			const bot = new Bot<{ count: number }>(bob);
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
					calls++;
					ctx.session.setItem(
						"count",
						((await ctx.session.getItem("count")) ?? 0) + 1,
					);
					assert.equal(
						(await ctx.thread({ limit: 1 })).coverage,
						"local-conversation",
					);
					await ctx.reply("pong");
				},
			);
			bot.handle(() => {
				fallback++;
			});
			let replies = 0;
			alice.handle(() => {
				replies++;
			});
			await alice.start();
			await bot.start();
			await bob.idle();
			assert.equal(calls, 0);
			const result = await alice.send(b.pubkey, "/ping");
			await until(() => replies === 1);
			await bob.idle();
			assert.equal(calls, 1);
			assert.equal(fallback, 0);
			const message = alice
				.history(b.pubkey)
				.messages.find((m) => m.id === result.id);
			assert.ok(message);
			const r = message.rumor;
			const policy = mode === "nip17" ? standardEnvelope : undefined;
			const key = mode === "nip17" ? b.pubkey : getPublicKey(b.encryptionKey);
			assert.equal(
				await bob.receive(await wrap(r, a, b.pubkey, key, policy), "live"),
				false,
			);
			assert.equal(bob.store.session<{ count: number }>(a.pubkey)?.count, 1);
			const page = bob.history(a.pubkey, { limit: 1 });
			assert.ok(page.nextCursor);
			assert.notEqual(
				bob.history(a.pubkey, { cursor: page.nextCursor, limit: 1 }).messages[0]
					.id,
				page.messages[0].id,
			);
			relay.reject(true);
			const pending = await alice.send(b.pubkey, "retry after restart");
			assert.equal(pending.status, "pending");
			const saved = alice.store.outbox()[0].events.map((x) => x.event.id);
			await alice.close();
			await bot.client.close();
			bot.dispose();
			relay.reject(false);
			alice = new Client(aOptions);
			bob = new Client(bOptions);
			let replay = 0;
			bob.handle(() => {
				replay++;
			});
			await bob.start();
			await bob.idle();
			assert.equal(replay, 0);
			assert.equal(bob.store.session<{ count: number }>(a.pubkey)?.count, 1);
			await alice.start();
			await until(() => replay === 1);
			await bob.idle();
			assert.equal(alice.store.outbox().length, 0);
			assert.ok(saved.every((id) => relay.events.has(id)));
			assert.equal(
				bob.history(a.pubkey).messages.filter((m) => m.id === pending.id)
					.length,
				1,
			);
		} finally {
			await alice.close();
			await bob.close();
			await relay.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("standard publication uses advertised recipient relays, never discovery fallback", async () => {
	const discovery = await testRelay(),
		inbox = await testRelay();
	const a = localNip17Identity(),
		b = localNip17Identity(),
		wire = new WebSocketTransport();
	const alice = new Client({
		...options(a, [discovery.url]),
		mode: "nip17",
		nip4eCompatibility: false,
	});
	const bob = new Client({
		...options(b, [inbox.url]),
		mode: "nip17",
		nip4eCompatibility: false,
	});
	try {
		await alice.announce();
		await bob.announce();
		await wire.publish(
			[discovery.url],
			await b.sign({
				kind: 10050,
				created_at: Math.floor(Date.now() / 1000),
				tags: [["relay", inbox.url]],
				content: "",
			}),
		);
		let received = "";
		bob.handle((m) => {
			received = m.text;
		});
		await bob.start();
		const sent = await alice.send(b.pubkey, "advertised inbox only");
		assert.equal(sent.status, "relay-accepted");
		await until(() => received !== "");
		assert.equal(received, "advertised inbox only");
		assert.ok(
			[...inbox.events.values()].some(
				(e) => e.kind === 1059 && e.tags[0][1] === b.pubkey,
			),
		);
		assert.ok(
			![...discovery.events.values()].some(
				(e) => e.kind === 1059 && e.tags[0][1] === b.pubkey,
			),
		);
		assert.ok(
			[...discovery.events.values()].some(
				(e) => e.kind === 1059 && e.tags[0][1] === a.pubkey,
			),
		);
		assert.ok(
			![...discovery.events.values(), ...inbox.events.values()].some(
				(e) => e.kind === 10044,
			),
		);
	} finally {
		wire.close();
		await alice.close();
		await bob.close();
		await discovery.close();
		await inbox.close();
	}
});

test("mode namespace isolates claimed inputs, accepted history, outbox, sessions and checkpoints on restart", async () => {
	const relay = await testRelay(),
		dir = await mkdtemp(join(tmpdir(), "psst-mode-scope-"));
	const secret = generateSecretKey(),
		split = localIdentity(secret),
		pure = localNip17Identity(secret),
		sender = localNip17Identity(),
		key = generateSecretKey();
	const base = {
		mode: "nip4e" as const,
		identity: split,
		relays: [relay.url],
		storageKey: key,
		database: join(dir, "shared.sqlite"),
	};
	let client = new Client(base);
	try {
		await client.start();
		const splitRumor = rumor(
			sender.pubkey,
			split.pubkey,
			"split recovered claim",
		);
		const splitEvent = await wrap(
			splitRumor,
			sender,
			split.pubkey,
			getPublicKey(split.encryptionKey),
		);
		assert.equal(await client.receive(splitEvent, "history"), true);
		client.store.saveSession(sender.pubkey, { label: "split" });
		client.store.saveCheckpoint("ws://scope.invalid", 111);
		client.store.putOutbox("split-outbox", [
			{ event: splitEvent, relays: [relay.url] },
		]);
		await client.close();
		client = new Client({ ...base, identity: pure, mode: "nip17" });
		assert.equal(client.history(sender.pubkey).messages.length, 0);
		assert.equal(client.store.outbox().length, 0);
		assert.equal(client.store.pending().length, 0);
		assert.equal(client.store.session(sender.pubkey), undefined);
		assert.equal(client.store.checkpoint("ws://scope.invalid"), undefined);
		let handled = 0;
		client.handle(() => {
			handled++;
		});
		await client.start();
		assert.equal(await client.receive(splitEvent, "live"), true);
		const standard = await wrap(
			rumor(sender.pubkey, pure.pubkey, "pure live"),
			sender,
			pure.pubkey,
			pure.pubkey,
			standardEnvelope,
		);
		await client.receive(standard, "live");
		await client.idle();
		assert.equal(handled, 2);
		client.store.saveSession(sender.pubkey, { label: "pure" });
		client.store.saveCheckpoint("ws://scope.invalid", 222);
		await client.close();
		client = new Client(base);
		assert.equal(client.store.pending().length, 0);
		assert.equal(client.store.outbox()[0].id, "split-outbox");
		assert.deepEqual(client.store.session(sender.pubkey), { label: "split" });
		assert.equal(client.store.checkpoint("ws://scope.invalid"), 111);
		assert.deepEqual(
			client.history(sender.pubkey).messages.map((message) => message.text),
			["split recovered claim"],
		);
		await client.start();
		assert.equal(
			await client.receive(splitEvent, "live"),
			false,
			"split mode remembers the recovered ID",
		);
		await client.close();
		client = new Client({ ...base, identity: pure, mode: "nip17" });
		assert.ok(
			client
				.history(sender.pubkey)
				.messages.some((m) => m.text === "pure live"),
		);
		assert.deepEqual(client.store.session(sender.pubkey), { label: "pure" });
		assert.equal(client.store.checkpoint("ws://scope.invalid"), 222);
	} finally {
		await client.close();
		await relay.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a signer cannot silently change the selected seal policy", async () => {
	const sender = localNip17Identity(),
		receiver = localNip17Identity();
	const altered = {
		...sender,
		sign: (template: Parameters<Identity["sign"]>[0]) =>
			sender.sign({ ...template, tags: [["n", sender.pubkey]] }),
	};
	await assert.rejects(
		wrap(
			rumor(sender.pubkey, receiver.pubkey, "strict outbound"),
			altered,
			receiver.pubkey,
			receiver.pubkey,
			standardEnvelope,
		),
		/invalid or altered event/,
	);
});
