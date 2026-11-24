import assert from "node:assert/strict";
import { Bot, generateSecretKey, nsecSigner, type Input } from "chirli";
import { npubEncode } from "nostr-tools/nip19";
import { MemoryRelay } from "./_support.js";
// Offline only: disposable identities and a memory relay. No external model or service.
const network = new MemoryRelay(),
	signer = nsecSigner(generateSecretKey()),
	userSigner = nsecSigner(generateSecretKey()),
	relays = ["ws://public-demo.invalid"];
const wire = network.transport(),
	publicReplies: string[] = [];
const transport = {
	...wire,
	publish: async (
		urls: string[],
		event: Parameters<typeof wire.publish>[1],
	) => {
		if (event.kind === 1111) publicReplies.push(event.content);
		await wire.publish(urls, event);
	},
};
const bot = new Bot({
	signer,
	database: ":memory:",
	relays,
	transport,
	publicInbox: { relays },
});
const user = new Bot({
	signer: userSigner,
	database: ":memory:",
	relays,
	transport: network.transport(),
});
const scopes = ["kind:14", "kind:1", "kind:1111"] as const;
bot.command({ command: "ping", scopes }, async (ctx) => {
	await ctx.reply("pong");
});
// Application-owned deterministic mock. Replace this function with your own processor.
const summarize = async (entries: Input[]) =>
	`Mock summary: ${entries.map((entry) => entry.text).join(" | ")}`;
bot.command({ command: "summarize", scopes }, async (ctx) => {
	const thread = await ctx.thread({ limit: 10 });
	await ctx.reply(await summarize(thread.entries));
});
let dm = "";
user.handle((ctx) => {
	dm = ctx.input.text;
});
try {
	await bot.start();
	await user.start();
	await user.send(bot.pubkey, "/ping");
	await bot.idle();
	await user.idle();
	assert.equal(dm, "pong");
	console.log("kind 14 /ping -> encrypted pong");
	const author = await userSigner.getPublicKey(),
		target = npubEncode(bot.pubkey);
	const root = await userSigner.signEvent({
		kind: 1,
		created_at: Math.floor(Date.now() / 1000),
		tags: [],
		content: `/ping@nostr:${target}`,
	});
	await wire.publish(relays, root);
	await bot.idle();
	assert.equal(publicReplies.at(-1), "pong");
	console.log("kind 1 /ping -> public kind 1111 pong");
	const comment = await userSigner.signEvent({
		kind: 1111,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			["E", root.id, "", author],
			["K", "1"],
			["P", author],
			["e", root.id, "", author],
			["k", "1"],
			["p", author],
		],
		content: `/ping@nostr:${target}`,
	});
	await wire.publish(relays, comment);
	await bot.idle();
	assert.equal(publicReplies.at(-1), "pong");
	console.log("kind 1111 /ping -> public kind 1111 pong");
	const request = await userSigner.signEvent({
		kind: 1111,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			["E", root.id, "", author],
			["K", "1"],
			["P", author],
			["e", comment.id, "", author],
			["k", "1111"],
			["p", author],
		],
		content: `/summarize@nostr:${target}`,
	});
	await wire.publish(relays, request);
	await bot.idle();
	assert.ok(publicReplies.at(-1)?.startsWith("Mock summary:"));
	console.log("kind 1111 /summarize -> application-owned mock, ancestors only");
} finally {
	await bot.close();
	await user.close();
	wire.close();
	await signer.close();
	await userSigner.close();
}
