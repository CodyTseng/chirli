import {z} from 'zod';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bot,InvalidArgsError,generateSecretKey,nsecSigner,type BotCommandDefinition,type CommandHandler} from 'chirli';
import {MemoryRelay} from './_support.js';

// Disposable identities and a memory relay only. Reuse the same signer across restart phases.
for(const mode of ['nip4e','nip17'] as const){
  const directory=await mkdtemp(join(tmpdir(),'chirli-nipcd-')),database=join(directory,'bot.sqlite'),storageKey=generateSecretKey();
  const network=new MemoryRelay(),relays=['ws://nipcd-demo.invalid'],signer=nsecSigner(generateSecretKey()),userSigner=nsecSigner(generateSecretKey());
  const user=new Bot({signer:userSigner,mode,database:':memory:',relays,transport:network.transport()});
  const create=()=>{
    const service=new Bot({signer,mode,database,storageKey,relays,transport:network.transport()});
    service.use(async(ctx,next)=>{if(ctx.sender!==user.pubkey)return;try{await next();}catch(error){if(!(error instanceof InvalidArgsError))throw error;await ctx.reply('Usage: /sum <0..100> <0..100> [note]');}});
    return service;
  };
  let bot=create();const replies:string[]=[];user.handle(ctx=>{replies.push(ctx.input.text);});
  const definition={command:'sum',title:'Sum',description:'Add two unsigned integers in a private message.',scopes:['kind:14'],args:z.object({left:z.bigint().min(0n).max(100n).meta({label:'Left'}),right:z.bigint().min(0n).max(100n).meta({label:'Right'}),note:z.string().optional().meta({label:'Note',nipcdType:'text'})})} as const satisfies BotCommandDefinition;
  const add:CommandHandler<typeof definition>=async(ctx,{left,right,note})=>{assert.equal(ctx.args.left,left);await ctx.reply(note?`${left+right} (${note})`:String(left+right));};
  const help=()=>bot.command({command:'help',scopes:['kind:14']},()=>{});
  const catalog=()=>user.discoverCommands({authors:[bot.pubkey],relays});
  const request=async(text:string)=>{const count=replies.length;await user.send(bot.pubkey,text);await bot.idle();await user.idle();assert.equal(replies.length,count+1);return replies[count];};
  try{
    bot.command(definition,add);help();await user.start();await bot.start();const pubkey=bot.pubkey;assert.equal((await catalog()).commands.length,2);
    assert.equal(await request('/sum 7 5 demo'),'12 (demo)');console.log(`${mode}: /sum 7 5 demo -> 12 (demo)`);
    assert.equal(await request('/sum 101 1'),'Usage: /sum <0..100> <0..100> [note]');console.log(`${mode}: Zod range rejection -> centralized usage response`);
    await bot.close();bot=create();help();await bot.start();assert.equal(bot.pubkey,pubkey);assert.equal((await catalog()).commands.length,1);
    // Runtime additions still synchronize automatically; this wait only makes the assertion deterministic.
    bot.command({...definition,title:'Addition'},(ctx,args)=>add(ctx,args));await bot.syncCommands();assert.equal((await catalog()).commands.find(item=>item.definition.command==='sum')!.definition.title,'Addition');
    await bot.close();bot=create();await bot.start();assert.equal(bot.pubkey,pubkey);assert.equal((await catalog()).commands.length,0);
    console.log(`${mode}: public commands across restart 2 -> 1 -> 2 -> 0`);
  }finally{await bot.close();await user.close();await signer.close();await userSigner.close();await rm(directory,{recursive:true,force:true});}
}
