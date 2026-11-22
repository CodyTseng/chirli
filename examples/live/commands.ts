import { runLive } from './runtime.js';

await runLive('commands', 'Send /help, /ping or /whoami in a DM.', bot => {
  bot.command({command:"help",title:"help",description:"Run /help in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => {
    await ctx.reply('Commands: /ping, /whoami, /help');
  }, { title: 'Help', description: 'List the available DM commands.' });

  bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => {
    await ctx.reply('pong');
  }, { title: 'Ping', description: 'Reply pong.' });

  bot.command({command:"whoami",title:"whoami",description:"Run /whoami in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => {
    await ctx.reply(`Your authenticated identity: ${ctx.sender}`);
  }, { title: 'Who am I?', description: 'Show your authenticated Nostr identity.' });

  bot.handle(async ctx => {
    await ctx.reply('Send /help for commands.');
  });
});
