import { z } from "zod";
import { localIdentity } from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getEventHash, nip44 } from "nostr-tools";
import {
	generateSecretKey,
	getPublicKey,
	WebSocketTransport,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { announcement, rumor, unwrap, wrap } from "../src/protocol.js";
import { testRelay } from "./relay.js";
const pause = () => new Promise((r) => setTimeout(r, 30));
async function until(fn: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (fn()) return;
		await pause();
	}
	assert.fail("condition timeout");
}

test("WebSocket E2E: discovery, self copy, command consumption, history, rumor dedup, restart", async () => {
	const relay = await testRelay(),
		a = localIdentity(),
		b = localIdentity(),
		key = generateSecretKey();
	const dir = await mkdtemp(join(tmpdir(), "psst-sdk-")),
		path = join(dir, "b.sqlite");
	const alice = new Client({
		mode: "nip4e",
		identity: a,
		relays: [relay.url],
		database: ":memory:",
		storageKey: generateSecretKey(),
	});
	let bob = new Client({
		mode: "nip4e",
		identity: b,
		relays: [relay.url],
		storageKey: key,
		database: path,
	});
	try {
		await alice.announce();
		await bob.announce();
		// A signed pre-activation receipt must not claim its ID, retain payload, or execute.
		const old = rumor(a.pubkey, b.pubkey, "/ping old", Date.now() - 10000);
		const oldWrap = await wrap(old, a, b.pubkey, getPublicKey(b.encryptionKey));
		const setup = new WebSocketTransport();
		try {
			await setup.publish([relay.url], oldWrap);
		} finally {
			setup.close();
		}
		const bot = new Bot<{ count: number }>(bob);
		let commands = 0,
			texts = 0;
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
				ctx.session.setItem(
					"count",
					((await ctx.session.getItem("count")) ?? 0) + 1,
				);
				await ctx.reply("pong");
			},
		);
		bot.handle(async () => {
			texts++;
		});
		await alice.start();
		await bot.start();
		await bob.idle();
		assert.equal(commands, 0);
		assert.equal(bob.getMessage(old.id), undefined);
		assert.equal(await bob.receive(oldWrap, "live"), false);
		const sent = await alice.send(b.pubkey, "/ping");
		assert.equal(sent.status, "relay-accepted");
		await until(() => commands === 1);
		await bob.idle();
		assert.equal(texts, 0);
		assert.equal(bob.store.session<{ count: number }>(a.pubkey)?.count, 1);
		const message = alice
			.history(b.pubkey)
			.messages.find((m) => m.id === sent.id);
		assert.ok(message);
		const r = message.rumor;
		const duplicate = await wrap(r, a, b.pubkey, getPublicKey(b.encryptionKey));
		assert.equal(await bob.receive(duplicate, "live"), false);
		await bob.idle();
		assert.equal(commands, 1);
		await alice.send(b.pubkey, "ordinary");
		await until(() => texts === 1);
		await bob.idle();
		const first = bob.history(a.pubkey, { limit: 2 });
		assert.equal(first.messages.length, 2);
		assert.ok(first.nextCursor);
		assert.equal(first.complete, false);
		const second = bob.history(a.pubkey, {
			limit: 2,
			cursor: first.nextCursor,
		});
		assert.ok(
			second.messages.every((m) => !first.messages.some((x) => x.id === m.id)),
		);
		await bot.client.close();
		bot.dispose();
		const bytes = await readFile(path);
		assert.ok(!bytes.includes(Buffer.from("/ping old")));
		bob = new Client({
			mode: "nip4e",
			identity: b,
			relays: [relay.url],
			storageKey: key,
			database: path,
		});
		let replay = 0;
		bob.handle(() => {
			replay++;
		});
		await bob.start();
		await bob.idle();
		assert.equal(replay, 0);
		assert.equal(bob.history(a.pubkey).messages.length, 3);
		assert.equal(bob.getMessage(old.id), undefined);
	} finally {
		await alice.close();
		await bob.close();
		await relay.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("strict envelope validation, old keys and anti-rollback evidence", async () => {
	const a = localIdentity(),
		b = localIdentity(),
		r = rumor(a.pubkey, b.pubkey, "verified");
	const e = await wrap(r, a, b.pubkey, getPublicKey(b.encryptionKey));
	assert.equal(unwrap(e, b)?.rumor.id, r.id);
	assert.equal(unwrap({ ...e, sig: "0".repeat(128) }, b), undefined);
	assert.equal(unwrap({ ...e, tags: [["p", a.pubkey]] }, b), undefined);
	const rotated = {
		...b,
		encryptionKey: generateSecretKey(),
		oldEncryptionKeys: [b.encryptionKey],
	};
	assert.equal(unwrap(e, rotated)?.rumor.id, r.id);
	const enc = (s: string, k: Uint8Array, p: string) =>
		nip44.v2.encrypt(s, nip44.v2.utils.getConversationKey(k, p));
	const fake = { ...r, pubkey: b.pubkey };
	fake.id = getEventHash(fake);
	const seal = await a.sign({
		kind: 13,
		created_at: r.created_at,
		tags: [["n", getPublicKey(a.encryptionKey)]],
		content: enc(
			JSON.stringify(fake),
			a.encryptionKey,
			getPublicKey(b.encryptionKey),
		),
	});
	const eph = generateSecretKey();
	const forged = finalizeEvent(
		{
			kind: 1059,
			created_at: r.created_at,
			tags: [["p", b.pubkey]],
			content: enc(JSON.stringify(seal), eph, getPublicKey(b.encryptionKey)),
		},
		eph,
	);
	assert.equal(unwrap(forged, b), undefined);
	const relay = await testRelay(),
		client = new Client({
			mode: "nip4e",
			identity: b,
			relays: [relay.url],
			database: ":memory:",
			storageKey: generateSecretKey(),
		});
	try {
		await client.start();
		const current = rumor(a.pubkey, b.pubkey, "eligible seal evidence");
		assert.equal(
			await client.receive(
				await wrap(current, a, b.pubkey, getPublicKey(b.encryptionKey)),
				"live",
			),
			true,
		);
		await client.idle();
		const old = await announcement(
			{ ...a, encryptionKey: generateSecretKey() },
			current.created_at - 10,
		);
		const transport = new WebSocketTransport();
		await transport.publish([relay.url], old);
		await transport.publish(
			[relay.url],
			await a.sign({
				kind: 10050,
				created_at: 10,
				tags: [["relay", relay.url]],
				content: "",
			}),
		);
		transport.close();
		assert.equal(
			(await client.refreshPeer(a.pubkey)).encryptionPubkey,
			getPublicKey(a.encryptionKey),
		);
	} finally {
		await client.close();
		await relay.close();
	}
});

test("failed inbound work stays claimed while persistent outbox retries exact message identities", async () => {
	const relay = await testRelay(),
		a = localIdentity(),
		b = localIdentity(),
		dir = await mkdtemp(join(tmpdir(), "psst-retry-")),
		path = join(dir, "state.db"),
		key = generateSecretKey();
	const alice = new Client({
		mode: "nip4e",
		identity: a,
		relays: [relay.url],
		database: ":memory:",
		storageKey: generateSecretKey(),
	});
	let bob = new Client({
		mode: "nip4e",
		identity: b,
		relays: [relay.url],
		storageKey: key,
		database: path,
	});
	try {
		await alice.announce();
		await bob.announce();
		let attempts = 0;
		bob.handle(async () => {
			attempts++;
			throw new Error("business failed");
		});
		await bob.start();
		const failed = await alice.send(b.pubkey, "failed inbound");
		await until(() => attempts === 1);
		await bob.idle();
		await bob.close();
		bob = new Client({
			mode: "nip4e",
			identity: b,
			relays: [relay.url],
			storageKey: key,
			database: path,
		});
		bob.handle(() => {
			attempts++;
		});
		await bob.start();
		await bob.idle();
		assert.equal(attempts, 1);
		assert.equal(bob.getMessageState(failed.id), "failed");
		relay.reject(true);
		const result = await bob.send(a.pubkey, "persist outbox");
		assert.equal(result.status, "pending");
		const saved = bob.store.outbox()[0];
		assert.equal(saved.id, result.id);
		const ids = saved.events.map((x) => x.event.id);
		await bob.close();
		relay.reject(false);
		bob = new Client({
			mode: "nip4e",
			identity: b,
			relays: [relay.url],
			storageKey: key,
			database: path,
		});
		await bob.start();
		assert.equal(bob.store.outbox().length, 0);
		assert.ok(ids.every((id) => relay.events.has(id)));
		assert.equal(
			bob.history(a.pubkey).messages.filter((x) => x.id === result.id).length,
			1,
		);
	} finally {
		await alice.close();
		await bob.close();
		await relay.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("exclusive routing and per-conversation concurrency", async () => {
	const relay = await testRelay(),
		b = localIdentity(),
		a = localIdentity(),
		c = localIdentity();
	const client = new Client({
		mode: "nip4e",
		identity: b,
		relays: [relay.url],
		database: ":memory:",
		storageKey: generateSecretKey(),
	});
	const bot = new Bot(client);
	const seen: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	bot.command(
		{
			command: "go",
			title: "go",
			description: "Run /go in a private message.",
			scopes: ["kind:14"],
			args: z.object({
				text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
			}),
		},
		() => {
			seen.push("command");
		},
	);
	bot.handle(async (ctx) => {
		seen.push(ctx.input.text);
		if (ctx.input.text === "first") await gate;
	});
	try {
		await bot.start();
		for (const [identity, text] of [
			[a, "first"],
			[a, "second"],
			[c, "other"],
		] as const)
			await client.receive(
				await wrap(
					rumor(identity.pubkey, b.pubkey, text),
					identity,
					b.pubkey,
					getPublicKey(b.encryptionKey),
				),
				"live",
			);
		await until(() => seen.includes("other"));
		assert.ok(!seen.includes("second"));
		release();
		await client.idle();
		assert.deepEqual(seen, ["first", "other", "second"]);
		await client.receive(
			await wrap(
				rumor(a.pubkey, b.pubkey, "/go"),
				a,
				b.pubkey,
				getPublicKey(b.encryptionKey),
			),
			"live",
		);
		await client.idle();
		assert.deepEqual(seen, ["first", "other", "second", "command"]);
	} finally {
		release();
		await bot.client.close();
		bot.dispose();
		await relay.close();
	}
});

test("decrypts fixture generated by unchanged PsstPsst envelope functions", async () => {
	const fixture = JSON.parse(
		await readFile(
			new URL("./fixtures/upstream.json", import.meta.url),
			"utf8",
		),
	);
	const identity = {
		pubkey: fixture.recipient.pubkey,
		encryptionKey: Buffer.from(fixture.recipient.encryptionSecret, "hex"),
		sign: async () => {
			throw new Error("unused");
		},
	};
	assert.deepEqual(unwrap(fixture.giftWrap, identity)?.rumor, fixture.rumor);
});

test("rejects malformed rumor IDs, missing split-key tags and invalid seals", async () => {
	const a = localIdentity(),
		b = localIdentity(),
		r = rumor(a.pubkey, b.pubkey, "bad envelope");
	const encrypt = (value: unknown, k: Uint8Array, p: string) =>
		nip44.v2.encrypt(
			JSON.stringify(value),
			nip44.v2.utils.getConversationKey(k, p),
		);
	const envelope = async (
		payload: unknown,
		tags: string[][],
		badSig = false,
	) => {
		let seal = await a.sign({
			kind: 13,
			created_at: r.created_at,
			tags,
			content: encrypt(payload, a.encryptionKey, getPublicKey(b.encryptionKey)),
		});
		if (badSig) seal = { ...seal, sig: "0".repeat(128) };
		const ephemeral = generateSecretKey();
		return finalizeEvent(
			{
				kind: 1059,
				created_at: r.created_at,
				tags: [["p", b.pubkey]],
				content: encrypt(seal, ephemeral, getPublicKey(b.encryptionKey)),
			},
			ephemeral,
		);
	};
	const tags = [["n", getPublicKey(a.encryptionKey)]];
	for (const event of [
		await envelope({ ...r, id: "0".repeat(64) }, tags),
		await envelope(r, []),
		await envelope(r, [["n", "bad"], ...tags]),
		await envelope(r, tags, true),
	])
		assert.equal(unwrap(event, b), undefined);
});
