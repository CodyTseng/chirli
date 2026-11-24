import { z } from "zod";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { InvalidArgsError } from "chirli";
import { createDemo } from "./_support.js";

// A message routes to a matching command or to the text handler.
const demo = createDemo();
const bot = demo.service;
bot.use(async (ctx, next) => {
	try {
		await next();
	} catch (error) {
		if (!(error instanceof InvalidArgsError)) throw error;
		await ctx.reply("Usage: /roll <1..20>");
	}
});
bot.command(
	{
		command: "roll",
		scopes: ["kind:14"],
		args: z.object({
			sides: z.bigint().min(1n).max(20n).meta({ label: "Sides" }),
		}),
	},
	async (ctx, args) => {
		const rolled = randomInt(1, Number(ctx.args.sides) + 1);
		await ctx.reply(`Rolled ${rolled} on a ${args.sides}-sided die.`);
	},
);
bot.command(
	{
		command: "help",
		title: "help",
		description: "Run /help in a private message.",
		scopes: ["kind:14"],
		args: z.object({
			text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
		}),
	},
	async (ctx) => {
		await ctx.reply("Commands: /help, /ping, /roll <1..20>");
	},
);
bot.command(
	{
		command: "ping",
		title: "ping",
		description: "Run /ping in a private message.",
		scopes: ["kind:14"],
		args: z.object({
			text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
		}),
	},
	async (ctx) => {
		await ctx.reply("pong");
	},
);
bot.handle(async (ctx) => {
	await ctx.reply(`Text handler received: ${ctx.input.text}`);
});
try {
	await demo.start();
	for (const [request, expected] of [
		["/help", "Commands: /help, /ping, /roll <1..20>"],
		["/ping", "pong"],
		["hello", "Text handler received: hello"],
	]) {
		const response = await demo.request(request);
		assert.equal(response, expected);
		console.log(`${request} -> ${response}`);
	}
	const rolled = await demo.request("/roll 6");
	assert.match(rolled, /^Rolled [1-6] on a 6-sided die\.$/);
	console.log(`/roll 6 -> ${rolled}`);
	for (const text of ["/roll", "/roll invalid", "/roll 21"]) {
		assert.equal(await demo.request(text), "Usage: /roll <1..20>");
		console.log(`${text} -> Usage: /roll <1..20>`);
	}
} finally {
	await demo.close();
}
