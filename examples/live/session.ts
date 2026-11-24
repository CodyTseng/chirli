import {z} from 'zod';
import { runLive } from './runtime.js';

type State = { name: string; visits: number };

await runLive<State>('session', 'Send /start, then your name. Later messages count persistent visits.', bot => {
  bot.command({command:"start",title:"start",description:"Run /start in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
    ctx.session.clear();
    await ctx.reply('What is your name?');
  });

  bot.command({command:"help",title:"help",description:"Run /help in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
    await ctx.reply('Send /start to reset your conversation, then your name.');
  });

  bot.handle(async ctx => {
    const name = await ctx.session.getItem('name');
    if (name === undefined) {
      const newName = ctx.input.text.trim().slice(0, 80);
      if (!newName) {
        await ctx.reply('Please send a name.');
        return;
      }
      ctx.session.setItem('name', newName);
      await ctx.reply(`Nice to meet you, ${newName}.`);
      return;
    }

    const visits = (await ctx.session.getItem('visits') ?? 0) + 1;
    ctx.session.setItem('visits', visits);
    await ctx.reply(`Hello ${name}, visit ${visits}.`);
  });
});
