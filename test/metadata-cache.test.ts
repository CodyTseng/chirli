import { localIdentity, localNip17Identity } from "../src/protocol.js";
import { identityFromSigner } from "../src/signers.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	matchFilter,
	verifyEvent,
	nip44,
	type Event,
	type Filter,
} from "nostr-tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateSecretKey,
	getPublicKey,
	nsecSigner,
	bunkerSigner,
	Nip4eCompatibilityError,
	type Transport,
} from "../src/index.js";
import { nsecEncode } from "nostr-tools/nip19";
import { MemoryRelay } from "../examples/_support.js";
import { rumor, wrap, unwrap } from "../src/protocol.js";
import { MessagingMetadata } from "../src/messaging-metadata.js";
import { KeySync } from "../src/key-sync.js";
import { Store } from "../src/store.js";
import { mockBunker } from "./bunker.js";
async function until(check: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	assert.fail("condition timeout");
}
const url = "ws://memory.invalid";
for (const mode of ["nip17", "nip4e"] as const)
	test(`${mode}: own subscribed state and peer cache remove repeated queries; seal key and own DM fallback deliver`, async () => {
		const network = new MemoryRelay(),
			raw = network.transport(),
			queries: Filter[] = [],
			published: { event: Event; relays: string[] }[] = [];
		const transport: Transport = {
			...raw,
			query: async (relays, filter) => {
				queries.push(filter);
				return raw.query(relays, filter);
			},
			publish: async (relays, event) => {
				published.push({ event, relays: [...relays] });
				await raw.publish(relays, event);
			},
		};
		const client = new Client({
				mode,
				identity: localNip17Identity(),
				relays: [url],
				database: ":memory:",
				transport,
				keySync: false,
			}),
			peer = localIdentity();
		try {
			await client.announce();
			await client.start();
			const before = queries.length;
			await client.receive(
				await wrap(
					rumor(peer.pubkey, client.pubkey, "incoming evidence"),
					peer,
					client.pubkey,
					client.encryptionKeys().currentPublicKey,
				),
				"live",
			);
			await client.idle();
			assert.equal(
				client.store.evidence(peer.pubkey)?.key,
				getPublicKey(peer.encryptionKey),
			);
			await client.send(peer.pubkey, "first");
			assert.equal(queries.length, before + 1);
			assert.deepEqual(queries.at(-1)?.authors, [peer.pubkey]);
			const reply = published.find(
				(item) =>
					item.event.kind === 1059 &&
					item.event.tags.some((t) => t[0] === "p" && t[1] === peer.pubkey),
			);
			assert.ok(reply);
			assert.deepEqual(reply.relays, [url]);
			assert.equal(unwrap(reply.event, peer)?.rumor.content, "first");
			await client.send(peer.pubkey, "second");
			assert.equal(
				queries.length,
				before + 1,
				"warm reply has no own or peer network query",
			);
			const nextRelay = "ws://new-inbox.invalid";
			await raw.publish(
				[url],
				await Reflect.get(client, "account").sign({
					kind: 10050,
					created_at: Math.floor(Date.now() / 1000) + 1,
					tags: [["relay", nextRelay]],
					content: "",
				}),
			);
			await client.send(peer.pubkey, "updated self inbox");
			assert.ok(
				published.some(
					(item) =>
						item.event.kind === 1059 &&
						item.event.tags[0][1] === client.pubkey &&
						item.relays[0] === nextRelay,
				),
			);
			assert.equal(
				published
					.filter(
						(item) =>
							item.event.kind === 1059 && item.event.tags[0][1] === peer.pubkey,
					)
					.at(-1)?.relays[0],
				nextRelay,
			);
			const forged = await Reflect.get(client, "account").sign({
				kind: 10044,
				created_at: Math.floor(Date.now() / 1000) + 2,
				tags: [["n", peer.pubkey]],
				content: "",
			});
			await raw
				.publish([url], { ...forged, sig: "0".repeat(128) })
				.catch(() => {});
			await client.send(peer.pubkey, "forgery ignored");
			await raw.publish([url], forged);
			await assert.rejects(
				client.send(peer.pubkey, "conflict"),
				Nip4eCompatibilityError,
			);
			assert.equal(queries.length, before + 1);
		} finally {
			await client.close();
		}
	});
test("confirmed absence is cached, concurrent cold requests coalesce, explicit refresh bypasses, stale usable entry refreshes in background", async (ctx) => {
	let now = Date.now();
	ctx.mock.method(Date, "now", () => now);
	const store = new Store(":memory:", undefined, "cache-test"),
		identity = localNip17Identity(),
		peer = localNip17Identity();
	let events: Event[] = [],
		queries = 0;
	const transport: Transport = {
		query: async (_urls, filter) => {
			queries++;
			return events.filter((e) => matchFilter(filter, e));
		},
		publish: async () => {},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
	};
	const cache = new MessagingMetadata(
		identity.pubkey,
		store,
		transport,
		[url],
		() => {},
		false,
		{ ttlMs: 1000, negativeTtlMs: 100, maxStaleMs: 10000, maxEntries: 2 },
	);
	try {
		await Promise.all([
			cache.read(peer.pubkey, [10044, 10050]),
			cache.read(peer.pubkey, [10050]),
		]);
		assert.equal(queries, 1);
		await cache.read(peer.pubkey, [10050]);
		assert.equal(queries, 1);
		events = [
			await peer.sign({
				kind: 10050,
				created_at: 10,
				tags: [["relay", url]],
				content: "",
			}),
		];
		await cache.read(peer.pubkey, [10050], true);
		assert.equal(queries, 2);
		now += 1001;
		events = [
			await peer.sign({
				kind: 10050,
				created_at: 20,
				tags: [["relay", "ws://new.invalid"]],
				content: "",
			}),
		];
		const stale = await cache.read(peer.pubkey, [10050]);
		assert.equal(stale[0].created_at, 10);
		await cache.idle();
		assert.equal((await cache.read(peer.pubkey, [10050]))[0].created_at, 20);
		assert.equal(queries, 3);
		transport.query = async () => {
			throw new Error("offline");
		};
		await assert.rejects(cache.read(peer.pubkey, [10050], true));
	} finally {
		await cache.stop();
		store.close();
	}
});
test("all peer lookup failures can use a verified incoming seal key and local inbox fallback, but explicit refresh reports the failure", async () => {
	const client = new Client({
			identity: localNip17Identity(),
			database: ":memory:",
			relays: [url],
			transport: {
				query: async () => {
					throw new Error("offline");
				},
				publish: async () => {},
				subscribe: () => ({ ready: Promise.resolve(), close() {} }),
				close() {},
			},
		}),
		peer = localIdentity();
	try {
		await client.start();
		await client.receive(
			await wrap(
				rumor(peer.pubkey, client.pubkey, "key evidence"),
				peer,
				client.pubkey,
				client.pubkey,
			),
			"live",
		);
		await client.idle();
		assert.equal(
			(await client.send(peer.pubkey, "reply")).status,
			"relay-accepted",
		);
		await assert.rejects(client.refreshPeer(peer.pubkey), /offline/);
	} finally {
		await client.close();
	}
});
test("key transfer verifies same identity, aliases, freshness and requested held key; never exports identity secrets and deduplicates retries/restart", async () => {
	const identity = localNip17Identity(),
		other = localNip17Identity(),
		encryption = generateSecretKey(),
		requester = generateSecretKey(),
		client = getPublicKey(requester),
		store = new Store(":memory:", generateSecretKey(), "sync-test"),
		published: Event[] = [];
	let fail = true,
		exported = 0;
	const transport: Transport = {
		query: async () => [],
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		publish: async (_urls, event) => {
			published.push(event);
			if (fail) throw new Error("uncertain ACK");
		},
		close() {},
	};
	const exporter = (key?: string) => {
		exported++;
		return key === getPublicKey(encryption)
			? new Uint8Array(encryption)
			: undefined;
	};
	let sync = new KeySync(identity, store, transport, [url], exporter, () =>
		getPublicKey(encryption),
	);
	const template = {
		kind: 4454,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			["P", client],
			["pubkey", client],
			["n", getPublicKey(encryption)],
			["relay", url],
		],
		content: "",
	};
	try {
		const valid = await identity.sign(structuredClone(template));
		for (const event of [
			{ ...valid, sig: "0".repeat(128) },
			await other.sign(template),
			await identity.sign({
				...template,
				tags: [
					["P", client],
					["pubkey", other.pubkey],
				],
			}),
			await identity.sign({
				...template,
				created_at: template.created_at - 301,
			}),
		])
			await sync.handle(event);
		assert.equal(exported, 0);
		assert.equal(published.length, 0);
		await assert.rejects(sync.handle(valid));
		assert.equal(exported, 1);
		fail = false;
		await sync.handle(valid);
		assert.equal(exported, 1);
		assert.equal(published[0].id, published[1].id);
		assert.ok(verifyEvent(published[0]));
		const response = published[0],
			sender = response.tags.find((t) => t[0] === "P")?.[1];
		assert.ok(sender);
		assert.equal(
			nip44.v2.decrypt(
				response.content,
				nip44.v2.utils.getConversationKey(requester, sender),
			),
			Buffer.from(encryption).toString("hex"),
		);
		assert.equal(response.pubkey, identity.pubkey);
		sync = new KeySync(
			identity,
			store,
			transport,
			[url],
			() => {
				assert.fail("completed request was replayed");
			},
			() => getPublicKey(encryption),
		);
		await sync.handle(valid);
		assert.equal(published.length, 2);
		const identityOnly = new KeySync(
			identity,
			store,
			transport,
			[url],
			() => new Uint8Array(identity.encryptionKey),
			() => identity.pubkey,
		);
		await identityOnly.handle(
			await identity.sign({
				...template,
				tags: [["P", client]],
				created_at: template.created_at + 1,
			}),
		);
		assert.equal(published.length, 2);
	} finally {
		sync.stop();
		await sync.idle();
		store.close();
	}
});
for (const signerType of ["nsec", "bunker"] as const)
	test(`${signerType}: a new split device synchronizes automatically, tracks a live rotation and keeps encrypted keys across restart`, async () => {
		const network = new MemoryRelay(),
			remote = signerType === "bunker" ? await mockBunker() : undefined,
			secret = generateSecretKey(),
			storageKey = generateSecretKey(),
			signer = remote
				? bunkerSigner(remote.uri, { clientSecret: generateSecretKey() })
				: nsecSigner(nsecEncode(secret)),
			identity = await identityFromSigner(signer),
			dir = await mkdtemp(join(tmpdir(), "chirli-sync-"));
		const owner = new Client({
			identity,
			mode: "nip4e",
			relays: [url],
			database: ":memory:",
			transport: network.transport(),
			keySync: { timeoutMs: 1000 },
		});
		const options = {
			identity,
			mode: "nip4e" as const,
			relays: [url],
			database: join(dir, "state.sqlite"),
			storageKey,
			transport: network.transport(),
			keySync: { timeoutMs: 1000 },
		};
		let device = new Client(options);
		try {
			await owner.announce();
			await owner.start();
			const initial = owner.encryptionKeys().currentPublicKey;
			await device.announce();
			await device.start();
			assert.equal(device.encryptionKeys().currentPublicKey, initial);
			await device.rotateEncryptionKey();
			const next = device.encryptionKeys().currentPublicKey;
			await until(() => owner.encryptionKeys().currentPublicKey === next);
			assert.ok(owner.encryptionKeys().decryptionPublicKeys.includes(initial));
			await device.close();
			device = new Client({ ...options, transport: network.transport() });
			await device.start();
			assert.equal(device.encryptionKeys().currentPublicKey, next);
		} finally {
			await device.close();
			await owner.close();
			await signer.close();
			await remote?.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
test("requester rejects forged, wrong-author, wrong-target and wrong-key transfers before importing a matching own-identity response", async () => {
	const identity = localNip17Identity(),
		attacker = localNip17Identity(),
		encryption = generateSecretKey(),
		expected = getPublicKey(encryption),
		store = new Store(":memory:", undefined, "requester-test");
	let receive!: (event: Event, source: "live" | "history") => void;
	let requests = 0;
	const transport: Transport = {
		query: async () => [],
		subscribe: (_urls, filter, callback) => {
			assert.deepEqual(filter.authors, [identity.pubkey]);
			if (_urls[0] === "ws://unavailable.invalid")
				return { ready: Promise.reject(new Error("unavailable")), close() {} };
			receive = callback;
			return { ready: Promise.resolve(), close() {} };
		},
		publish: async (_urls, request) => {
			assert.equal(request.kind, 4454);
			assert.ok(verifyEvent(request));
			assert.equal(request.pubkey, identity.pubkey);
			requests++;
			const client = request.tags.find((t) => t[0] === "P")?.[1],
				sender = generateSecretKey(),
				senderPubkey = getPublicKey(sender);
			assert.ok(client);
			const template = {
				kind: 4455,
				created_at: Math.floor(Date.now() / 1000),
				tags: [
					["P", senderPubkey],
					["p", identity.pubkey],
					["p", client],
				],
				content: nip44.v2.encrypt(
					Buffer.from(encryption).toString("hex"),
					nip44.v2.utils.getConversationKey(sender, client),
				),
			};
			const good = await identity.sign(structuredClone(template));
			for (const event of [
				{ ...good, sig: "0".repeat(128) },
				await attacker.sign(structuredClone(template)),
				await identity.sign({
					...template,
					tags: [
						["P", senderPubkey],
						["p", identity.pubkey],
					],
				}),
				await identity.sign({
					...template,
					content: nip44.v2.encrypt(
						Buffer.from(generateSecretKey()).toString("hex"),
						nip44.v2.utils.getConversationKey(sender, client),
					),
				}),
				await identity.sign({
					...template,
					created_at: template.created_at + 61,
				}),
				await identity.sign({
					...template,
					tags: [...template.tags, ["P", senderPubkey]],
				}),
			])
				receive(event, "live");
			receive(good, "live");
		},
		close() {},
	};
	const sync = new KeySync(
		identity,
		store,
		transport,
		[url, "ws://unavailable.invalid"],
		() => undefined,
		() => expected,
		{ timeoutMs: 1000 },
	);
	try {
		const first = sync.request(expected),
			second = sync.request(expected);
		const [a, b] = await Promise.all([first, second]);
		assert.equal(getPublicKey(a), expected);
		assert.equal(a, b);
		assert.equal(requests, 1);
		a.fill(0);
	} finally {
		sync.stop();
		await sync.idle();
		store.close();
	}
});
test("stopping a key-sync requester cancels even an unfinished subscription without retaining its ephemeral key", async () => {
	const identity = localNip17Identity(),
		store = new Store(":memory:", undefined, "cancel-sync");
	let closed = false;
	const transport: Transport = {
		query: async () => [],
		subscribe: () => ({
			ready: new Promise<void>(() => {}),
			close() {
				closed = true;
			},
		}),
		publish: async () => assert.fail("unready requester cannot publish"),
		close() {},
	};
	const sync = new KeySync(
		identity,
		store,
		transport,
		[url],
		() => undefined,
		() => getPublicKey(generateSecretKey()),
		{ timeoutMs: 1000 },
	);
	try {
		const request = sync.request(getPublicKey(generateSecretKey()));
		sync.stop();
		await assert.rejects(request, /stopped/);
		await sync.idle();
		assert.ok(closed);
	} finally {
		store.close();
	}
});
for (const mode of ["nip17", "nip4e"] as const)
	test(`${mode}: newer authenticated seal key wins over a warm older announcement cache`, async () => {
		const network = new MemoryRelay(),
			wire = network.transport(),
			senderSecret = generateSecretKey(),
			old = localIdentity(senderSecret),
			current = localIdentity(senderSecret),
			sent: Event[] = [];
		const transport: Transport = {
			...wire,
			publish: async (relays, event) => {
				sent.push(event);
				await wire.publish(relays, event);
			},
		};
		const client = new Client({
			identity: localNip17Identity(),
			mode,
			relays: [url],
			database: ":memory:",
			transport,
			keySync: false,
		});
		try {
			await client.announce();
			await client.start();
			await wire.publish(
				[url],
				await old.sign({
					kind: 10044,
					created_at: 10,
					tags: [["n", getPublicKey(old.encryptionKey)]],
					content: "",
				}),
			);
			await wire.publish(
				[url],
				await old.sign({
					kind: 10050,
					created_at: 10,
					tags: [["relay", url]],
					content: "",
				}),
			);
			await client.refreshPeer(old.pubkey);
			await client.receive(
				await wrap(
					rumor(current.pubkey, client.pubkey, "new signed seal"),
					current,
					client.pubkey,
					client.encryptionKeys().currentPublicKey,
				),
				"live",
			);
			await client.idle();
			await client.send(current.pubkey, "new-key reply");
			const reply = sent.find(
				(event) => event.kind === 1059 && event.tags[0][1] === current.pubkey,
			);
			assert.ok(reply);
			assert.equal(unwrap(reply, current)?.rumor.content, "new-key reply");
			assert.equal(unwrap(reply, old), undefined);
		} finally {
			await client.close();
		}
	});

test("stale peer refresh uses at most four background workers and drains on idle", async (ctx) => {
	let now = Date.now();
	ctx.mock.method(Date, "now", () => now);
	const store = new Store(":memory:", undefined, "bounded-cache"),
		own = localNip17Identity(),
		peers = Array.from({ length: 6 }, () => localNip17Identity()),
		events = await Promise.all(
			peers.map((peer) =>
				peer.sign({
					kind: 10050,
					created_at: 10,
					tags: [["relay", url]],
					content: "",
				}),
			),
		);
	let blocked = false,
		active = 0,
		maximum = 0,
		release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const transport: Transport = {
		query: async (_urls, filter) => {
			active++;
			maximum = Math.max(maximum, active);
			try {
				if (blocked) await gate;
				return events.filter((event) => matchFilter(filter, event));
			} finally {
				active--;
			}
		},
		publish: async () => {},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
	};
	const cache = new MessagingMetadata(
		own.pubkey,
		store,
		transport,
		[url],
		() => {},
		false,
		{ ttlMs: 1, maxStaleMs: 10000 },
	);
	try {
		for (const peer of peers) await cache.read(peer.pubkey, [10050]);
		now += 2;
		blocked = true;
		maximum = 0;
		await Promise.all(peers.map((peer) => cache.read(peer.pubkey, [10050])));
		assert.equal(active, 4);
		release();
		await cache.idle();
		assert.equal(maximum, 4);
		assert.equal(active, 0);
	} finally {
		release();
		await cache.stop();
		store.close();
	}
});
