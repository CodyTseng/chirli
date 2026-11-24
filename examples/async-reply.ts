import assert from "node:assert/strict";
import { Bot, generateSecretKey, nsecSigner, type Rumor } from "chirli";
import type { Event } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { MemoryRelay } from "./_support.js";

// Application-owned work list, not an SDK job queue. Memory-only, no credentials or network.
const work: (Event | Rumor)[] = [],
	network = new MemoryRelay(),
	wire = network.transport(),
	relays = ["ws://async-demo.invalid"];
const signer = nsecSigner(generateSecretKey()),
	userSigner = nsecSigner(generateSecretKey());
const bot = new Bot({
	signer,
	database: ":memory:",
	relays,
	publicInbox: { relays },
	transport: network.transport(),
});
const user = new Bot({
	signer: userSigner,
	database: ":memory:",
	relays,
	transport: network.transport(),
});
let privateReply = "";
user.handle((ctx) => {
	privateReply = ctx.input.text;
});
bot.command(
	{ command: "work", scopes: ["kind:14", "kind:1", "kind:1111"] },
	(ctx) => {
		work.push(structuredClone(ctx.input.event)); // Save the original event, not a context or ID.
	},
);
try {
	await bot.start();
	await user.start();
	await user.send(bot.pubkey, "/work");
	await bot.idle();
	const author = await userSigner.getPublicKey(),
		text = `/work@nostr:${npubEncode(bot.pubkey)}`;
	const root = await userSigner.signEvent({
		kind: 1,
		created_at: Math.floor(Date.now() / 1000),
		tags: [],
		content: text,
	});
	await wire.publish(relays, root);
	await bot.idle();
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
		content: text,
	});
	await wire.publish(relays, comment);
	await bot.idle();
	assert.equal(work.length, 3);
	// All handlers have returned. An application worker can now use the original events.
	for (const event of work) {
		const context = await bot.thread(event, { limit: 10 });
		const result = await bot.reply(
			event,
			`Finished kind ${event.kind}`,
			event.kind === 14 ? { replyTo: event.id } : undefined,
		);
		assert.equal(result.status, "relay-accepted");
		console.log(
			`After handler: kind ${event.kind} -> ${event.kind === 14 ? "encrypted DM" : "public kind 1111"}; ${context.coverage}`,
		);
	}
	await user.idle();
	assert.equal(privateReply, "Finished kind 14");
} finally {
	await bot.close();
	await user.close();
	wire.close();
	await signer.close();
	await userSigner.close();
}
