import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getEventHash, matchFilter, type Event } from "nostr-tools";
import {
	Bot,
	generateSecretKey,
	nsecSigner,
	type Transport,
} from "../src/index.js";
import {
	localNip17Identity,
	rumor,
	standardEnvelope,
	wrap,
} from "../src/protocol.js";
import { Client } from "./client.js";

const relay = "ws://activation.invalid";
const overlap = 176400;
function memoryWire(overrides: Partial<Transport> = {}): Transport {
	return {
		query: async () => [],
		publish: async () => {},
		subscribe: () => ({
			ready: Promise.resolve(),
			close() {},
		}),
		close() {},
		...overrides,
	};
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("first activation ignores older DMs but admits new initial and live copies once across restart", async (t) => {
	const activation = 1_800_000_000_500;
	let now = activation;
	t.mock.method(Date, "now", () => now);
	t.mock.method(Math, "random", () => 0.75);
	const temp = await mkdtemp(join(tmpdir(), "chirli-activation-"));
	const signer = nsecSigner(generateSecretKey()),
		owner = await signer.getPublicKey(),
		peer = localNip17Identity();
	const calls: string[] = [],
		middleware: string[] = [];
	let initial: Event[] = [];
	const wire = memoryWire({
		subscribe: (_urls, filter, receive) => {
			for (const event of initial)
				if (matchFilter(filter, event)) receive(event, "history");
			return { ready: Promise.resolve(), close() {} };
		},
	});
	const build = () => {
		const bot = new Bot({
			signer,
			relays: [relay],
			transport: wire,
			database: join(temp, "state.sqlite"),
			keySync: false,
			recovery: false,
		});
		bot.use(async (ctx, next) => {
			middleware.push(ctx.input.text);
			await next();
		});
		bot.handle((ctx) => {
			calls.push(ctx.input.text);
			if (ctx.input.text === "failed command")
				throw new Error("synthetic failure");
		});
		return bot;
	};
	const dm = (text: string, at: number) => rumor(peer.pubkey, owner, text, at);
	const gift = (message: ReturnType<typeof dm>) =>
		wrap(message, peer, owner, owner, standardEnvelope);
	const old = dm("too old", activation - 1),
		atFloor = dm("at activation boundary", activation);
	const failed = dm("failed command", activation + 1),
		disconnected = dm("missed while disconnected", activation + 90_000);
	const noMs = dm("first activation second without extension", activation);
	noMs.tags = noMs.tags.filter(([name]) => name !== "ms");
	noMs.id = getEventHash(noMs);
	const oldOwn = rumor(owner, peer.pubkey, "old outgoing", activation - 1);
	const ownIdentity = {
		pubkey: owner,
		identityEncryption: {
			publicKey: owner,
			asynchronous: true,
			encrypt: (text: string, key: string) => signer.nip44Encrypt(key, text),
			decrypt: (text: string, key: string) => signer.nip44Decrypt(key, text),
		},
		sign: signer.signEvent.bind(signer),
	};
	const ownWrap = await wrap(
		oldOwn,
		ownIdentity,
		owner,
		owner,
		standardEnvelope,
	);
	const oldWrap = await gift(old),
		boundaryWrap = await gift(atFloor);
	assert.ok(
		boundaryWrap.created_at < Math.floor(activation / 1000) - 100000,
		"backdated wrapper intentionally precedes the activation",
	);
	initial = [
		oldWrap,
		ownWrap,
		boundaryWrap,
		await gift(noMs),
		await gift(failed),
	];
	let bot = build();
	try {
		now = activation - 100000;
		await bot.announce();
		now = activation;
		await bot.start();
		await bot.idle();
		assert.deepEqual(calls, [
			"at activation boundary",
			"first activation second without extension",
			"failed command",
		]);
		assert.deepEqual(middleware, calls);
		for (const event of [oldWrap, ownWrap, boundaryWrap, await gift(failed)])
			assert.equal(await bot.receive(event, "live"), false);
		assert.equal(bot.getMessage(old.id), undefined);
		assert.equal(bot.getMessage(oldOwn.id), undefined);
		assert.equal(bot.getMessageState(failed.id), "failed");
		await bot.close();
		now += 120_000;
		initial = [
			oldWrap,
			boundaryWrap,
			await gift(failed),
			await gift(disconnected),
		];
		bot = build();
		await bot.start();
		await bot.idle();
		assert.deepEqual(calls, [
			"at activation boundary",
			"first activation second without extension",
			"failed command",
			"missed while disconnected",
		]);
		assert.deepEqual(middleware, calls);
		assert.equal(await bot.receive(await gift(disconnected), "live"), false);
		assert.equal(
			bot.getMessage(disconnected.id)?.source,
			"history",
			"source stays diagnostic only",
		);
	} finally {
		await bot.close();
		await signer.close();
		await rm(temp, { recursive: true, force: true });
	}
});

test("an uninitialized relay scans from persisted first activation minus giftwrap overlap", async (t) => {
	const activation = 1_800_000_000_500;
	let now = activation;
	t.mock.method(Date, "now", () => now);
	const temp = await mkdtemp(join(tmpdir(), "chirli-recovery-baseline-"));
	const owner = localNip17Identity(),
		peer = localNip17Identity();
	const missed = await wrap(
		rumor(peer.pubkey, owner.pubkey, "uncovered old gap", activation + 1000),
		peer,
		owner.pubkey,
		owner.pubkey,
		standardEnvelope,
	);
	const options = {
		identity: owner,
		relays: [relay],
		database: join(temp, "state.sqlite"),
		keySync: false as const,
	};
	let client = new Client({
		...options,
		transport: memoryWire(),
		recovery: false,
	});
	try {
		await client.start();
		assert.equal(client.store.checkpoint(relay), undefined);
		await client.close();
		now += 3 * 86_400_000;
		const scanned: number[] = [];
		client = new Client({
			...options,
			transport: memoryWire({
				subscribe: (_urls, filter, receive) => {
					if (filter.since !== undefined) {
						scanned.push(filter.since);
						if (matchFilter(filter, missed)) receive(missed, "history");
					}
					return { ready: Promise.resolve(), close() {} };
				},
			}),
		});
		const calls: string[] = [];
		client.handle((message) => {
			calls.push(message.text);
		});
		await client.start();
		await client.idle();
		assert.deepEqual(scanned, [Math.floor(activation / 1000) - overlap]);
		assert.deepEqual(calls, ["uncovered old gap"]);
		assert.equal(client.store.checkpoint(relay), Math.floor(now / 1000));
	} finally {
		await client.close();
		await rm(temp, { recursive: true, force: true });
	}
});

test("stopping during manual catch-up leaves the old checkpoint and lets restart dispatch the input once", async (t) => {
	const activation = 1_800_000_000_500;
	let now = activation;
	t.mock.method(Date, "now", () => now);
	const owner = localNip17Identity(),
		peer = localNip17Identity(),
		local = owner.identityEncryption;
	assert.ok(local);
	const entered = deferred(),
		release = deferred();
	let delay = false,
		calls = 0,
		events: Event[] = [];
	const identity = {
		...owner,
		identityEncryption: {
			...local,
			asynchronous: true,
			async decrypt(text: string, key: string) {
				if (delay) {
					delay = false;
					entered.resolve();
					await release.promise;
				}
				return local.decrypt(text, key);
			},
		},
	};
	const client = new Client({
		identity,
		relays: [relay],
		keySync: false,
		database: ":memory:",
		transport: memoryWire({
			subscribe: (_urls, filter, receive) => {
				if (filter.since !== undefined)
					for (const e of events)
						if (matchFilter(filter, e)) receive(e, "history");
				return { ready: Promise.resolve(), close() {} };
			},
		}),
	});
	client.handle(() => {
		calls++;
	});
	try {
		await client.start();
		const checkpoint = client.store.checkpoint(relay);
		assert.equal(checkpoint, Math.floor(activation / 1000));
		now += 10000;
		const event = await wrap(
			rumor(peer.pubkey, owner.pubkey, "in-flight sync", now),
			peer,
			owner.pubkey,
			owner.pubkey,
			standardEnvelope,
		);
		events = [event];
		delay = true;
		const outstanding = client.syncHistory();
		await entered.promise;
		const stopping = client.stop();
		release.resolve();
		assert.equal((await outstanding)[0].status, "aborted");
		await stopping;
		assert.equal(client.store.checkpoint(relay), checkpoint);
		assert.equal(calls, 0);
		await client.start();
		await client.idle();
		assert.equal(calls, 1);
		assert.equal(await client.receive(event, "live"), false);
		assert.equal(client.store.checkpoint(relay), Math.floor(now / 1000));
	} finally {
		release.resolve();
		await client.close();
	}
});
