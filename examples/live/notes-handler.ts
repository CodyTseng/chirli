import {z} from 'zod';
import { parseCommand, type Bot, type BotCommandDefinition } from 'chirli';

const rememberDefinition = {
  command: 'remember',
  title: 'Remember',
  description: 'Save a note in local DM history.',
  args: z.object({"text":z.string().optional().meta({label:'Note',nipcdType:'text'})}),
  scopes: ['kind:14'],
} as const satisfies BotCommandDefinition;

/** Application behavior stays independent of credentials, CLI output and signal handling. */
export function configureNotes(bot: Bot): void {
  bot.command({command:"help",title:"help",description:"Run /help in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
    await ctx.reply('Commands: /remember <text>, /notes (latest 10 local notes)');
  });

  bot.command(rememberDefinition, async (ctx, { text = '' }) => {
    const note = text.trim();
    const response = !note
      ? 'Usage: /remember <text>'
      : note.length > 1000
        ? 'Use at most 1000 characters per note.'
        : 'Saved in local DM history.';
    await ctx.reply(response);
  });

  bot.command({command:"notes",title:"notes",description:"Run /notes in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
    const notes: string[] = [];
    let cursor: string | undefined;

    // Bounded local context only. Use the command parser for the same qualifier rules as intake.
    for (let page = 0; page < 10 && notes.length < 10; page++) {
      const history = ctx.history({ limit: 100, cursor });
      for (const message of history.messages) {
        if (message.direction !== 'incoming') continue;
        const parsed = parseCommand(bot.getCommandDefinitions().find(definition=>definition.command===rememberDefinition.command)!, message.rumor, {
          executor: bot.pubkey,
          relay: message.relay,
        });
        if (parsed.status !== 'matched') continue;
        const text = String(parsed.invocation.args.text ?? '').trim();
        if (text && text.length <= 1000) notes.push(text);
        if (notes.length === 10) break;
      }
      cursor = history.nextCursor;
      if (!cursor) break;
    }

    await ctx.reply(notes.length
      ? `Latest local notes:\n${notes.map(text => `- ${text}`).join('\n')}`
      : 'No local notes found. Send /remember <text>.');
  });

  bot.handle(async ctx => {
    await ctx.reply('Send /help for note commands.');
  });
}
