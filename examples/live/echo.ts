import { runLive } from "./runtime.js";

await runLive("echo", "Send any text in a DM to receive an echo.", (bot) => {
	bot.handle(async (ctx) => {
		await ctx.reply(`Echo: ${ctx.input.text.slice(0, 2000)}`);
	});
});
