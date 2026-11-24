import { test } from "node:test";
import assert from "node:assert/strict";
import { npubEncode } from "nostr-tools/nip19";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import {
	Bot,
	nsecSigner,
	generateSecretKey,
	allowlist,
	type Input,
	type Transport,
} from "../src/index.js";
import {
	localNip17Identity,
	rumor,
	wrap,
	standardEnvelope,
} from "../src/protocol.js";
import {
	PublicThreads,
	threadStructure,
	commentReply,
} from "../src/public-thread.js";
import { MemoryRelay } from "../examples/_support.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const urls = ["ws://one.invalid", "ws://two.invalid"];
const author = localNip17Identity(),
	other = localNip17Identity();
const note = (content: string, tags: string[][] = []) =>
	author.sign({
		kind: 1,
		created_at: Math.floor(Date.now() / 1000),
		content,
		tags,
	});
const comment = async (root: Event, parent: Event, text: string) =>
	author.sign(
		commentReply(
			parent,
			{ id: root.id, kind: String(root.kind), author: root.pubkey },
			text,
		),
	);
function graph(events: Event[], overrides: Partial<Transport> = {}) {
	const queries: Filter[] = [];
	const transport: Transport = {
		query: async (_urls, filter) => {
			queries.push(filter);
			return events
				.filter((event) => matchFilter(filter, event))
				.slice(0, filter.limit);
		},
		publish: async () => {},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		close() {},
		...overrides,
	};
	return { transport, queries };
}
function setup(extra: Record<string, unknown> = {}) {
	const network = new MemoryRelay(),
		base = network.transport(),
		published: Event[] = [];
	const transport = {
		...base,
		publish: async (relays: string[], event: Event) => {
			published.push(event);
			await base.publish(relays, event);
		},
	};
	const bot = new Bot({
		signer: nsecSigner(generateSecretKey()),
		database: ":memory:",
		relays: urls,
		transport,
		publicInbox: { relays: urls },
		...extra,
	});
	return { bot, published, transport };
}

test("one command and input API receives kind 14, 1 and 1111; replies preserve privacy and NIP-22 root/parent", async () => {
	const { bot, published } = setup(),
		inputs: Input[] = [];
	const errors: unknown[] = [];
	bot.onError((error) => {
		errors.push(error);
	});
	bot.command(
		{ command: "ping", scopes: ["kind:14", "kind:1", "kind:1111"] },
		async (ctx) => {
			inputs.push(ctx.input);
			assert.equal(ctx.sender, author.pubkey);
			await ctx.reply("pong");
		},
	);
	try {
		await bot.start();
		const dm = rumor(author.pubkey, bot.pubkey, "/ping");
		await bot.receive(
			await wrap(dm, author, bot.pubkey, bot.pubkey, standardEnvelope),
			"live",
			{ relay: urls[0] },
		);
		await bot.idle();
		const root = await note(`/ping@nostr:${npubEncode(bot.pubkey)}`);
		assert.equal(await bot.receive(root, "live", { relay: urls[0] }), true);
		await bot.idle();
		const child = await comment(root, root, `/ping@${npubEncode(bot.pubkey)}`);
		assert.equal(await bot.receive(child, "live", { relay: urls[1] }), true);
		await bot.idle();
		assert.deepEqual(errors, []);
		assert.deepEqual(
			inputs.map((input) => input.event.kind),
			[14, 1, 1111],
		);
		assert.equal(inputs[0].id, dm.id);
		assert.ok(published.some((event) => event.kind === 1059));
		const replies = published.filter((event) => event.kind === 1111);
		assert.equal(replies.length, 2);
		assert.equal(threadStructure(replies[0]).root?.id, root.id);
		assert.equal(threadStructure(replies[1]).root?.id, root.id);
		assert.equal(threadStructure(replies[1]).parent?.id, child.id);
		assert.deepEqual(
			replies[1].tags.filter((tag) => tag[0] === "p"),
			[["p", author.pubkey]],
		);
	} finally {
		await bot.close();
	}
});
test("explicit scopes, verified source, target and allowlist gate public handlers", async () => {
	const { bot } = setup();
	let calls = 0,
		middleware = 0,
		fallback = 0;
	bot.use(allowlist([author.pubkey]));
	bot.command({ command: "ping", scopes: ["kind:1", "kind:1111"] }, () => {
		calls++;
	});
	bot.command({ command: "private", scopes: ["kind:14"] }, () =>
		assert.fail("DM command on public"),
	);
	bot.use(async (_ctx, next) => {
		middleware++;
		await next();
	});
	bot.handle(() => {
		fallback++;
	});
	try {
		await bot.start();
		const qualifier = npubEncode(bot.pubkey);
		for (const event of [
			await note("/ping"),
			await note(" /ping", [["p", bot.pubkey]]),
			await note("ordinary reply", [["p", bot.pubkey]]),
			await note(`/ping@${npubEncode(other.pubkey)}`, [["p", bot.pubkey]]),
			await note(`/private@${qualifier}`),
			await note("/ping", [
				["p", bot.pubkey],
				["p", other.pubkey],
			]),
		])
			assert.equal(await bot.receive(event, "live", { relay: urls[0] }), false);
		const valid = await note(`/ping@${qualifier}`);
		assert.equal(
			await bot.receive({ ...valid, sig: "0".repeat(128) }, "live", {
				relay: urls[0],
			}),
			false,
		);
		assert.equal(
			await bot.receive(valid, "live", { relay: "ws://untrusted.invalid" }),
			false,
		);
		assert.equal(await bot.receive(valid, "live"), false);
		const forbidden = await other.sign({
			kind: 1,
			created_at: 1,
			tags: [["p", bot.pubkey]],
			content: "/ping",
		});
		assert.equal(
			await bot.receive(forbidden, "live", { relay: urls[0] }),
			true,
		);
		await bot.idle();
		assert.equal(
			await bot.receive(forbidden, "live", { relay: urls[1] }),
			false,
		);
		assert.equal(await bot.receive(valid, "live", { relay: urls[0] }), true);
		assert.equal(
			await bot.receive(await note("/ping", [["p", bot.pubkey]]), "live", {
				relay: urls[0],
			}),
			true,
		);
		await bot.idle();
		assert.equal(calls, 2);
		assert.equal(middleware, 2);
		assert.equal(fallback, 0);
		assert.equal(bot.dmHistory(author.pubkey).messages.length, 0);
	} finally {
		await bot.close();
	}
});
test("public replay and replicas deduplicate durably across stop/start and reopen; public sessions stay separate", async () => {
	const directory = await mkdtemp(join(tmpdir(), "chirli-public-")),
		database = join(directory, "test.sqlite"),
		signer = nsecSigner(generateSecretKey()),
		network = new MemoryRelay();
	let calls = 0;
	const make = () =>
		new Bot<{ count: number }>({
			signer,
			database,
			transport: network.transport(),
			relays: urls,
			publicInbox: { relays: urls },
		});
	const register = (bot: ReturnType<typeof make>) =>
		bot.command({ command: "ping", scopes: ["kind:1"] }, async (ctx) => {
			assert.ok(ctx.conversation.startsWith("public:"));
			assert.equal("message" in ctx, false);
			assert.equal("history" in ctx, false);
			assert.equal("getMessage" in ctx, false);
			ctx.session.setItem(
				"count",
				((await ctx.session.getItem("count")) ?? 0) + 1,
			);
			calls++;
		});
	let bot = make();
	register(bot);
	try {
		await bot.start();
		await bot.setSession(author.pubkey, { count: 99 });
		const old = await note(`/ping@${npubEncode(bot.pubkey)}`);
		assert.equal(await bot.receive(old, "history", { relay: urls[0] }), true);
		assert.equal(await bot.receive(old, "live", { relay: urls[1] }), false);
		const live = await note("/ping", [["p", bot.pubkey]]);
		assert.equal(await bot.receive(live, "live", { relay: urls[0] }), true);
		assert.equal(await bot.receive(live, "live", { relay: urls[1] }), false);
		await bot.idle();
		assert.equal(calls, 1);
		assert.deepEqual(await bot.getSession(author.pubkey), { count: 99 });
		await bot.stop();
		await bot.start();
		assert.equal(await bot.receive(live, "live", { relay: urls[0] }), false);
		await bot.close();
		bot = make();
		register(bot);
		await bot.start();
		assert.equal(await bot.receive(live, "live", { relay: urls[0] }), false);
		await bot.idle();
		assert.equal(calls, 1);
	} finally {
		await bot.close();
		await rm(directory, { recursive: true, force: true });
	}
});
test("required kind scopes reject missing, duplicate and unsupported kinds; public reads require explicit inbox", async () => {
	const { bot } = setup();
	try {
		for (const scopes of [
			[],
			[`author:${author.pubkey}`],
			["kind:1", "kind:1"],
			["kind:7"],
		])
			assert.throws(
				() => bot.command({ command: "bad", scopes }, () => {}),
				/supported kind scopes/,
			);
		assert.throws(
			() => bot.command("ping" as never, () => {}),
			/explicit scopes/,
		);
	} finally {
		await bot.close();
	}
	const privateBot = new Bot({
		signer: nsecSigner(generateSecretKey()),
		database: ":memory:",
		relays: urls,
		transport: graph([]).transport,
	});
	privateBot.command({ command: "ping", scopes: ["kind:1"] }, () => {});
	await assert.rejects(privateBot.start(), /publicInbox/);
	await privateBot.close();
});
test("lazy root batch selects only mixed legacy/comment ancestors and ignores siblings, mentions and quotes", async () => {
	const root = await note("root"),
		legacy = await note("legacy", [["e", root.id, "", "root"]]),
		middle = await comment(root, legacy, "middle"),
		sibling = await comment(root, root, "sibling"),
		trigger = await comment(root, middle, "/summarize");
	const { transport, queries } = graph([
		root,
		legacy,
		middle,
		sibling,
		trigger,
	]);
	const threads = new PublicThreads(transport, urls);
	const result = await threads.resolve(trigger);
	assert.equal(result.complete, true);
	assert.deepEqual(
		result.entries.map((input) => input.text),
		["root", "legacy", "middle"],
	);
	assert.ok(
		queries.some(
			(filter) => filter.kinds?.[0] === 1 && filter["#e"]?.[0] === root.id,
		),
	);
	assert.ok(
		queries.some(
			(filter) => filter.kinds?.[0] === 1111 && filter["#E"]?.[0] === root.id,
		),
	);
	const positional = await note("positional", [
		["e", root.id],
		["e", legacy.id],
		["e", sibling.id, "", "mention"],
	]);
	assert.equal(threadStructure(positional).parent?.id, legacy.id);
	assert.deepEqual(
		(await threads.resolve(positional)).entries.map((input) => input.id),
		[root.id, legacy.id],
	);
	const lone = await note("lone", [["e", middle.id]]);
	assert.equal((await threads.rootForReply(lone)).id, root.id);
	const quote = await note(
		`quoted nostr:${(await import("nostr-tools/nip19")).noteEncode(root.id)}`,
		[["e", root.id]],
	);
	assert.equal(threadStructure(quote).parent, undefined);
});
test("thread bounds report missing data, timeout, size and mismatched roots without exposing unrelated branches", async () => {
	const root = await note("root"),
		missing = "a".repeat(64),
		trigger = await author.sign({
			kind: 1111,
			created_at: 1,
			content: "/ping",
			tags: [
				["E", root.id, "", root.pubkey],
				["K", "1"],
				["P", root.pubkey],
				["e", missing],
				["k", "1"],
				["p", author.pubkey],
			],
		});
	let resolver = new PublicThreads(graph([root]).transport, urls);
	let result = await resolver.resolve(trigger);
	assert.equal(result.complete, false);
	assert.equal(result.reason, "missing-parent");
	resolver = new PublicThreads(
		graph([], { query: async () => new Promise(() => {}) }).transport,
		urls,
		{ timeoutMs: 10 },
	);
	result = await resolver.resolve(trigger);
	assert.equal(result.reason, "timeout");
	const otherRoot = await note("unrelated"),
		bad = await comment(otherRoot, otherRoot, "bad branch"),
		mismatch = await comment(root, bad, "trigger");
	result = await new PublicThreads(
		graph([root, otherRoot, bad]).transport,
		urls,
	).resolve(mismatch);
	assert.equal(result.reason, "root-mismatch");
	assert.deepEqual(result.entries, []);
	const malformed = {
		...trigger,
		tags: trigger.tags.filter((tag) => tag[0] !== "K"),
	};
	assert.throws(() => threadStructure(malformed), /reference/);
	const legacy = await note("missing root", [["e", missing, "", "root"]]);
	await assert.rejects(resolver.rootForReply(legacy));
});
test("coordinate roots batch both coordinate kinds and direct replies preserve the address", async () => {
	const root = await author.sign({
			kind: 30023,
			created_at: 1,
			tags: [["d", "article"]],
			content: "article",
		}),
		address = `30023:${root.pubkey}:article`,
		child = await author.sign({
			kind: 1111,
			created_at: 2,
			content: "comment",
			tags: [
				["A", address],
				["K", "30023"],
				["P", root.pubkey],
				["a", address],
				["e", root.id, "", root.pubkey],
				["k", "30023"],
				["p", root.pubkey],
			],
		});
	const { transport, queries } = graph([root]);
	const resolver = new PublicThreads(transport, urls);
	const result = await resolver.resolve(child);
	assert.deepEqual(
		result.entries.map((input) => input.text),
		["article"],
	);
	assert.ok(queries.some((filter) => filter["#A"]?.[0] === address));
	assert.ok(queries.some((filter) => filter["#a"]?.[0] === address));
	assert.equal(
		commentReply(child, await resolver.rootForReply(child), "ok").tags[0][0],
		"A",
	);
});

test("loopback replicas reconnect without replaying old public commands or duplicating live ones", {
	timeout: 10000,
}, async () => {
	const { createLocalRelay } = await import("../examples/_relay.js"),
		one = await createLocalRelay(),
		two = await createLocalRelay();
	const { WebSocketTransport } = await import("../src/index.js");
	const relays = [one.url, two.url],
		bot = new Bot({
			signer: nsecSigner(generateSecretKey()),
			database: ":memory:",
			dmRelays: relays,
			readRelays: relays,
			writeRelays: relays,
			discoveryRelays: [],
			publicInbox: { relays },
			reconnect: { initialDelayMs: 10, maxDelayMs: 10, jitter: 0 },
		}),
		publisher = new WebSocketTransport(1000);
	let calls = 0;
	const until = async (check: () => boolean) => {
		const end = Date.now() + 3000;
		while (!check()) {
			if (Date.now() > end) throw new Error("Local test deadline");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	bot.command({ command: "ping", scopes: ["kind:1"] }, async (ctx) => {
		calls++;
		await ctx.reply("pong");
	});
	try {
		await bot.start();
		const event = await note(`/ping@nostr:${npubEncode(bot.pubkey)}`);
		await publisher.publish(relays, event);
		await until(() => calls === 1);
		await bot.idle();
		one.disconnect();
		two.disconnect();
		await until(() => one.connections >= 3 && two.connections >= 3);
		await new Promise((resolve) => setTimeout(resolve, 80));
		await bot.idle();
		assert.equal(calls, 1);
		await publisher.publish(relays, await note("/ping", [["p", bot.pubkey]]));
		await until(() => calls === 2);
		await bot.idle();
		assert.equal(
			[...one.events.values()].filter((e) => e.kind === 1111).length,
			2,
		);
	} finally {
		await bot.close();
		publisher.close();
		await one.close();
		await two.close();
	}
});
test("failed public processing is not replayed; outgoing reply retries retain the signed ID", async () => {
	const { bot, transport, published } = setup();
	let calls = 0;
	bot.command({ command: "ping", scopes: ["kind:1"] }, async (ctx) => {
		calls++;
		ctx.session.setItem("value", "public");
		await ctx.reply("ok");
		throw new Error("business failure");
	});
	const publish = transport.publish;
	let rejected = true;
	transport.publish = async (relays, event) => {
		if (event.kind === 1111 && rejected) {
			published.push(event);
			throw new Error("local ACK unavailable");
		}
		await publish(relays, event);
	};
	try {
		await bot.start();
		const event = await note("/ping", [["p", bot.pubkey]]);
		assert.equal(await bot.receive(event, "live", { relay: urls[0] }), true);
		await bot.idle();
		assert.equal(calls, 1);
		assert.equal(await bot.receive(event, "live", { relay: urls[1] }), false);
		const replies = () => published.filter((event) => event.kind === 1111);
		const original = replies()[0];
		assert.ok(original);
		const attempts = replies().length;
		rejected = false;
		await bot.flushOutbox();
		assert.equal(replies().length, attempts + 1);
		assert.ok(replies().every((reply) => reply.id === original.id));
		await bot.stop();
		await bot.start();
		assert.equal(calls, 1);
		assert.equal(await bot.getSession(author.pubkey), undefined);
	} finally {
		await bot.close();
	}
});

test("middleware mutation cannot rewrite authenticated public routing; a failing input stays claimed", async () => {
	let calls = 0;
	const { bot } = setup();
	bot.use(async (ctx, next) => {
		ctx.input.event.content = "/forged";
		ctx.input.event.pubkey = other.pubkey;
		await next();
	});
	bot.command({ command: "ping", scopes: ["kind:1"] }, () => {
		calls++;
		throw new Error("business failure");
	});
	try {
		await bot.start();
		const event = await note("/ping", [["p", bot.pubkey]]);
		assert.equal(await bot.receive(event, "live", { relay: urls[0] }), true);
		await bot.idle();
		assert.equal(calls, 1);
		assert.equal(await bot.receive(event, "live", { relay: urls[1] }), false);
		await bot.stop();
		await bot.start();
		assert.equal(calls, 1);
	} finally {
		await bot.close();
	}
});
test("targeted fallback, truncation and depth bounds are explicit and never include sibling context", async () => {
	const root = await note("root"),
		parent = await comment(root, root, "parent"),
		trigger = await comment(root, parent, "trigger"),
		queries: Filter[] = [];
	const fallback = graph([], {
		query: async (_urls, filter) => {
			queries.push(filter);
			return filter.ids?.includes(parent.id)
				? [parent]
				: filter.ids?.includes(root.id)
					? [root]
					: [];
		},
	}).transport;
	assert.deepEqual(
		(await new PublicThreads(fallback, urls).resolve(trigger)).entries.map(
			(input) => input.text,
		),
		["root", "parent"],
	);
	assert.ok(queries.some((filter) => filter.ids?.[0] === parent.id));
	const short = await new PublicThreads(graph([root, parent]).transport, urls, {
		maxDepth: 1,
	}).resolve(trigger);
	assert.equal(short.complete, false);
	assert.equal(short.reason, "depth-limit");
	const window = await new PublicThreads(
		graph([root, parent]).transport,
		urls,
		{ maxEvents: 1 },
	).resolve(trigger);
	assert.equal(window.complete, false);
});

test("public journal write failures neither lose admission nor forget an ACKed exact outbox event", async () => {
	const { PublicInbox } = await import("../src/public-inbox.js");
	let stored: unknown,
		saves = 0,
		failAt = 0,
		calls = 0;
	const publications: Event[] = [];
	const claimed = new Set<string>();
	let failClaim = true;
	const store = {
		metadata: () => structuredClone(stored),
		saveMetadata: (_key: string, value: unknown) => {
			if (++saves === failAt) throw new Error("local disk unavailable");
			stored = structuredClone(value);
		},
		claimInput(id: string) {
			if (failClaim) throw new Error("local disk unavailable");
			if (claimed.has(id)) return false;
			claimed.add(id);
			return true;
		},
	};
	const identity = localNip17Identity(),
		definition = {
			id: "ping",
			command: "ping",
			title: "Ping",
			description: "Ping",
			scopes: ["kind:1"],
		};
	const inbox = new PublicInbox(
		identity,
		store as never,
		graph([], {
			publish: async (_relays, event) => {
				publications.push(event);
			},
		}).transport,
		{ relays: urls },
		urls,
		false,
		() => [definition],
		async () => {
			calls++;
		},
		() => {},
	);
	try {
		await inbox.start([1]);
		const event = await note("/ping", [["p", identity.pubkey]]);
		assert.throws(() => inbox.receive(event, "live", urls[0]), /disk/);
		assert.equal(calls, 0);
		failClaim = false;
		assert.equal(inbox.receive(event, "live", urls[0]), true);
		await inbox.idle();
		assert.equal(calls, 1);
		// Reply insertion succeeds, then the ACK checkpoint fails. Retrying must keep the signed ID.
		failAt = saves + 2;
		const result = await inbox.reply(
			{ event, relay: urls[0], conversation: `public:e:${event.id}` },
			"pong",
		);
		assert.equal(result.status, "pending");
		assert.equal(publications.length, 1);
		await inbox.flush();
		assert.equal(publications.length, 2);
		assert.equal(publications[0].id, publications[1].id);
	} finally {
		inbox.stop();
		await inbox.idle();
	}
});

test("public middleware exceptions report operational failure without escaping relay callbacks", async () => {
	const network = new MemoryRelay(),
		wire = network.transport(),
		original = new Error("application policy"),
		errors: unknown[] = [];
	const bot = new Bot({
		signer: nsecSigner(generateSecretKey()),
		database: ":memory:",
		transport: network.transport(),
		relays: urls,
		publicInbox: { relays: urls },
	});
	bot.onError((error) => {
		errors.push(error);
	});
	bot.use(() => {
		throw original;
	});
	bot.command({ command: "ping", scopes: ["kind:1"] }, () =>
		assert.fail("must be denied"),
	);
	try {
		await bot.start();
		await wire.publish(urls, await note("/ping", [["p", bot.pubkey]]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(errors.includes(original));
		assert.equal(bot.dmHistory(author.pubkey).messages.length, 0);
	} finally {
		await bot.close();
		wire.close();
	}
});
