import {z} from 'zod';
import { type Bot, type Context } from 'chirli';
// Attach listeners before start(). The application owns decisions and side effects.
export function listen(bot: Bot) {
  return bot.handle(async ctx => {
    await ctx.reply(`You sent ${ctx.message.text.length} characters`);
  });
}
export function commands(bot: Bot<{count: number}>) {
  bot.command({command:"start",title:"start",description:"Run /start in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {await ctx.reply('Hello');});
  bot.command({command:"count",title:"count",description:"Run /count in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
    const count = (await ctx.session.getItem('count') ?? 0) + 1;
    ctx.session.setItem('count', count);
    await ctx.reply(String(count));
  });
  bot.handle(async ctx => {await ctx.reply('Text received');});
  bot.catch((_error,_ctx) => { /* Observe failure without logging secrets. Inbox stays retryable. */ });
  return bot;
}
// No provider, API token, prompt, or automatic history upload is built into the SDK.
export function withAI(bot: Bot, generate: (input: {text:string;context:Context})=>Promise<string>) {
  bot.handle(async ctx => {
    // A developer can explicitly request ctx.history({limit:10}) here if appropriate.
    await ctx.reply(await generate({text:ctx.message.text,context:ctx}));
  });
  return bot;
}
