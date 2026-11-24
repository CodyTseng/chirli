import { z } from "zod";
import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventHash, nip44, verifyEvent, type Event } from "nostr-tools";
import { Bot, generateSecretKey, nsecSigner } from "../src/index.js";
import {
	localIdentity,
	localNip17Identity,
	type Rumor,
} from "../src/protocol.js";
import { MemoryRelay } from "../examples/_support.js";
import { Client } from "./client.js";

for (const mode of ["nip17", "nip4e"] as const) {
	test(`${mode}: send a private reaction and retry the exact gift wrap`, async () => {
		const network = new MemoryRelay();
		const relays = ["wss://reactions.invalid"];
		const signer = nsecSigner(generateSecretKey());
		const identity = mode === "nip17" ? localNip17Identity() : localIdentity();
		const peerWire = network.transport(),
			botWire = network.transport();
		const peer = new Client({
			identity,
			mode,
			relays,
			database: ":memory:",
			transport: peerWire,
		});
		const attempts: Event[] = [];
		let blocked = true;
		const bot = new Bot({
			signer,
			mode,
			relays,
			database: ":memory:",
			transport: {
				...botWire,
				async publish(urls, event) {
					if (event.kind === 1059) {
						attempts.push(event);
						if (blocked) throw new Error("Relay unavailable");
					}
					await botWire.publish(urls, event);
				},
			},
		});
		let handled = 0;
		peer.handle(() => {
			handled++;
		});
		const sent: Awaited<ReturnType<Bot["react"]>>[] = [];
		bot.command(
			{
				command: "react",
				title: "react",
				description: "Run /react in a private message.",
				scopes: ["kind:14"],
				args: z.object({
					text: z
						.string()
						.optional()
						.meta({ label: "Text", nipcdType: "text" }),
				}),
			},
			async (ctx) => {
				sent.push(await ctx.react("👍"));
			},
		);
		const decrypt = (content: string, pubkey: string) =>
			nip44.v2.decrypt(
				content,
				nip44.v2.utils.getConversationKey(identity.encryptionKey, pubkey),
			);
		const unwrap = (event: Event): Rumor => {
			const seal: Event = JSON.parse(decrypt(event.content, event.pubkey));
			assert.ok(verifyEvent(seal));
			const key = seal.tags.find((tag) => tag[0] === "n")?.[1] ?? seal.pubkey;
			return JSON.parse(decrypt(seal.content, key));
		};

		try {
			await peer.announce();
			await peer.start();
			await bot.start();
			const original = await peer.send(bot.pubkey, "/react");
			await bot.idle();
			assert.equal(sent[0]?.status, "pending");
			const firstWrap = attempts[0];
			assert.ok(firstWrap);
			assert.ok(firstWrap.tags.every((tag) => tag[0] !== "e"));

			blocked = false;
			await bot.flushOutbox();
			assert.deepEqual(attempts[1], firstWrap);
			await peer.idle();
			const back = unwrap(firstWrap);
			assert.equal(back.id, sent[0]?.id);
			assert.equal(getEventHash(back), back.id);
			assert.equal(back.kind, 7);
			assert.equal(back.content, "👍");
			assert.deepEqual(
				back.tags.find((tag) => tag[0] === "e"),
				["e", original.id],
			);
			assert.deepEqual(
				back.tags.find((tag) => tag[0] === "p"),
				["p", peer.pubkey],
			);

			const message = bot.getMessage(original.id);
			assert.ok(message);
			const input = message.rumor;
			const like = await bot.react(input);
			assert.equal(like.status, "relay-accepted");
			const events = await botWire.query(relays, {
				kinds: [1059],
				"#p": [peer.pubkey],
			});
			assert.equal(
				events.map(unwrap).find((event) => event.id === like.id)?.content,
				"+",
			);
			await peer.idle();
			assert.equal(handled, 0);
			assert.equal(peer.getMessage(back.id), undefined);
			assert.equal(bot.getMessage(back.id), undefined);
			await assert.rejects(
				bot.react("0".repeat(64) as never),
				/Expected an input event, not an ID/,
			);
			await assert.rejects(
				bot.react({ ...input, content: "modified" }),
				/does not match an authenticated incoming record/,
			);
			await assert.rejects(bot.react(input, " "), /Nonempty reaction/);
		} finally {
			await Promise.all([bot.close(), peer.close()]);
			botWire.close();
			peerWire.close();
			await signer.close();
		}
	});
}

for (const kind of [1, 1111] as const) {
	test(`kind ${kind} reacts directly to the verified public event with configured routing`, async () => {
		const signer = nsecSigner(generateSecretKey());
		const author = localNip17Identity(),
			rootAuthor = localNip17Identity();
		const write = "wss://write.invalid/",
			source = "wss://source.invalid/",
			attacker = "wss://attacker.invalid/";
		const network = new MemoryRelay(),
			transport = network.transport();
		const published: { relays: string[]; event: Event }[] = [];
		let fail = false;
		const bot = new Bot({
			signer,
			database: ":memory:",
			dmRelays: [write],
			discoveryRelays: [],
			readRelays: [write],
			writeRelays: [write],
			publicInbox: { relays: [source] },
			transport: {
				...transport,
				publish: async (relays, event) => {
					if (event.kind === 7) {
						published.push({ relays: [...relays], event });
						if (fail) throw new Error("mock failure");
					}
					await transport.publish(relays, event);
				},
			},
		});
		let result: Awaited<ReturnType<Bot["react"]>> | undefined;
		bot.command({ command: "react", scopes: [`kind:${kind}`] }, async (ctx) => {
			result = await ctx.react("👍");
		});
		try {
			await bot.start();
			const now = Math.floor(Date.now() / 1000),
				root = await rootAuthor.sign({
					kind: 1,
					created_at: now,
					tags: [],
					content: "not the target",
				});
			const tags =
				kind === 1
					? [
							["p", bot.pubkey, attacker],
							["e", root.id, attacker, "mention"],
						]
					: [
							["E", root.id, attacker, root.pubkey],
							["K", "1"],
							["P", root.pubkey],
							["e", root.id, attacker, root.pubkey],
							["k", "1"],
							["p", root.pubkey],
							["p", bot.pubkey],
						];
			const input = await author.sign({
				kind,
				created_at: now,
				tags,
				content: `/react@nostr:${(await import("nostr-tools/nip19")).npubEncode(bot.pubkey)}`,
			});
			fail = true;
			assert.equal(await bot.receive(input, "live", { relay: source }), true);
			await bot.idle();
			assert.equal(result?.status, "pending");
			assert.equal(published.length, 1);
			const [first] = published;
			assert.equal(first.event.pubkey, bot.pubkey);
			assert.equal(verifyEvent(first.event), true);
			assert.equal(first.event.content, "👍");
			assert.deepEqual(first.relays, [write, source]);
			assert.deepEqual(first.event.tags, [
				["e", input.id, source, author.pubkey],
				["p", author.pubkey],
				...(kind === 1 ? [] : [["k", String(kind)]]),
			]);
			assert.equal(JSON.stringify(first).includes(attacker), false);
			fail = false;
			await bot.flushOutbox();
			assert.deepEqual(
				published[1],
				first,
				"outbox resends identical signed kind 7",
			);
			const delayed = await bot.react(input);
			assert.equal(delayed.status, "relay-accepted");
			assert.equal(published[2].event.content, "+");
			assert.deepEqual(published[2].relays, [write]);
			assert.deepEqual(published[2].event.tags[0], [
				"e",
				input.id,
				"",
				author.pubkey,
			]);
			await assert.rejects(
				bot.react({ ...input, sig: "0".repeat(128) }),
				/Expected a valid signed kind 1\/1111 event/,
			);
			await assert.rejects(bot.react(input, " "), /Nonempty reaction/);
			assert.equal(published.length, 3);
			assert.equal(bot.getMessage(input.id), undefined);
		} finally {
			await bot.close();
			transport.close();
			await signer.close();
		}
	});
}
