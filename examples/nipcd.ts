import assert from 'node:assert/strict';
import { type BotCommandDefinition, type CommandHandler } from 'chirli';
import { createDemo } from './_support.js';

// Memory transport only. All registered commands are public on configured write relays.
for (const mode of ['nip4e', 'nip17'] as const) {
  const demo = createDemo(mode), bot = demo.service;
  const definition = {
    command: 'sum', title: 'Sum', description: 'Add two unsigned integers in a private message.',
    args: [
      { name: 'left', type: 'number', required: true, label: 'Left' },
      { name: 'right', type: 'number', required: true, label: 'Right' },
      { name: 'note', type: 'text', required: false, label: 'Note' },
    ],
    scopes: ['kind:14'],
  } as const satisfies BotCommandDefinition;
  const add: CommandHandler<typeof definition> = async (ctx, { left, right, note }) => {
    const result = String(left + right);
    await ctx.reply(note ? `${result} (${note})` : result);
  };
  bot.command(definition,add,{authorize:ctx=>ctx.sender===demo.user.pubkey});
  bot.command({command:"help",title:"help",description:"Run /help in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{});
  const catalog = () => demo.user.discoverCommands({authors:[demo.service.pubkey],relays:['wss://demo.invalid']});
  try {
    await demo.start(); assert.equal((await catalog()).commands.length,2);
    assert.equal(await demo.request('/sum 7 5 demo'),'12 (demo)');
    console.log(`${mode}: /sum 7 5 demo -> 12 (demo)`);
    await bot.removeCommand(definition.command); assert.equal((await catalog()).commands.length,1);
    bot.command({...definition,title:'Addition'},add); await demo.service.syncCommands(); // Optional wait before asserting the automatically updated snapshot.
    assert.equal((await catalog()).commands.find(command=>command.definition.command===definition.command)!.definition.title,'Addition');
    await bot.removeCommand(definition.command); await bot.removeCommand('help');
    const empty = await catalog(); assert.equal(empty.commands.length,0);
    console.log(`${mode}: public commands 2 -> 1 -> 2 -> 0`);
  } finally { await demo.close(); }
}
