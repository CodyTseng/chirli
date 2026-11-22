import assert from 'node:assert/strict';
import { createDemo } from './_support.js';

// A message routes to a matching command or to the text handler.
const demo = createDemo();
const bot = demo.service;
bot.command({command:"help",title:"help",description:"Run /help in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => { await ctx.reply('Commands: /help, /ping'); });
bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => { await ctx.reply('pong'); });
bot.handle(async ctx => { await ctx.reply(`Text handler received: ${ctx.message.text}`); });
try {
  await demo.start();
  for (const [request, expected] of [
    ['/help', 'Commands: /help, /ping'],
    ['/ping', 'pong'],
    ['hello', 'Text handler received: hello'],
  ]) {
    const response = await demo.request(request);
    assert.equal(response, expected);
    console.log(`${request} -> ${response}`);
  }
} finally { await demo.close(); }
