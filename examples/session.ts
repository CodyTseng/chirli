import { z } from "zod";
import assert from "node:assert/strict";
import { createDemo } from "./_support.js";

type State = { name: string; visits: number };
const demo = createDemo<State>();
const bot = demo.service;

bot.command(
	{
		command: "start",
		title: "start",
		description: "Run /start in a private message.",
		scopes: ["kind:14"],
		args: z.object({
			text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
		}),
	},
	async (ctx) => {
		ctx.session.clear();
		await ctx.reply("What is your name?");
	},
);

bot.handle(async (ctx) => {
	const name = await ctx.session.getItem("name");
	if (name === undefined) {
		const newName = ctx.input.text.trim();
		ctx.session.setItem("name", newName);
		await ctx.reply(`Nice to meet you, ${newName}.`);
		return;
	}

	const visits = ((await ctx.session.getItem("visits")) ?? 0) + 1;
	ctx.session.setItem("visits", visits);
	await ctx.reply(`Hello ${name}, visit ${visits}.`);
});

try {
	await demo.start();
	for (const [request, expected] of [
		["/start", "What is your name?"],
		["Ada", "Nice to meet you, Ada."],
		["hello", "Hello Ada, visit 1."],
		["again", "Hello Ada, visit 2."],
	]) {
		const response = await demo.request(request);
		assert.equal(response, expected);
		console.log(`${request} -> ${response}`);
	}
} finally {
	await demo.close();
}
