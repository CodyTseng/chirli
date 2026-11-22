import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getEventHash,type Event} from 'nostr-tools';
import {npubEncode} from 'nostr-tools/nip19';
import {Bot,nsecSigner,generateSecretKey,type Input,type Rumor} from '../src/index.js';
import {localNip17Identity,rumor,wrap,standardEnvelope} from '../src/protocol.js';
import {commentReply,threadStructure} from '../src/public-thread.js';
import {MemoryRelay} from '../examples/_support.js';
const urls=['ws://async-memory.invalid'];
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

test('delayed DM replies and anchored threads match context before and after same-account database reopen',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chirli-delayed-dm-')),database=join(directory,'test.sqlite'),storageKey=generateSecretKey(),secret=generateSecretKey(),peerSecret=generateSecretKey(),peer=localNip17Identity(peerSecret),network=new MemoryRelay();
 const make=()=>new Bot({signer:nsecSigner(secret),storageKey,database,relays:urls,transport:network.transport()});
 let bot=make();const user=new Bot({signer:nsecSigner(peerSecret),database:':memory:',relays:urls,transport:network.transport()}),saved=new Map<string,Event|Rumor>(),received:Input[]=[];let contextThread:unknown;
 const register=()=>bot.handle(async ctx=>{saved.set(ctx.input.id,copy(ctx.input.event));if(ctx.input.text==='trigger'){contextThread=await ctx.thread({limit:2});await ctx.reply('from context',{replyTo:ctx.input.id});}});
 register();user.handle(ctx=>{received.push(ctx.input);});
 try{await user.start();await bot.start();const now=Date.now()-10000;
  const events=[rumor(peer.pubkey,bot.pubkey,'first',now),rumor(peer.pubkey,bot.pubkey,'second',now+1000),rumor(peer.pubkey,bot.pubkey,'trigger',now+2000),rumor(peer.pubkey,bot.pubkey,'later',now+3000)];
  for(const event of events){await bot.receive(await wrap(event,peer,bot.pubkey,bot.pubkey,standardEnvelope),'live',{relay:urls[0]});await bot.idle();}
  await user.idle();const target=saved.get(events[2].id)!;assert.deepEqual((contextThread as {entries:Input[]}).entries.map(input=>input.text),['first','second']);assert.deepEqual(await bot.thread(target,{limit:2}),contextThread);
  const result=await bot.reply(target,'after handler',{replyTo:target.id});assert.equal(result.status,'relay-accepted');await user.idle();assert.equal(received.at(-1)!.text,'after handler');assert.equal(received.at(-1)!.event.kind,14);assert.equal(received.at(-1)!.event.tags.find(tag=>tag[0]==='e')?.[1],target.id);
  await bot.close();bot=make();register();await bot.start();assert.deepEqual(await bot.thread(copy(target),{limit:2}),contextThread);await bot.reply(copy(target),'after restart',{replyTo:target.id});await user.idle();assert.equal(received.at(-1)!.text,'after restart');assert.equal(received.at(-1)!.event.pubkey,bot.pubkey);assert.equal(bot.history(peer.pubkey).messages.find(message=>message.text==='after restart')?.conversation,peer.pubkey);
  await assert.rejects(bot.thread(target,{limit:0}),/limit/);await assert.rejects(bot.reply(target,'bad',{replyTo:'bad'}),/reply|ID/i);
 }finally{await bot.close();await user.close();await rm(directory,{recursive:true,force:true});}
});

for(const kind of [1,1111])test(`kind ${kind}: serialized original public event works after completion and reopen with known source routing`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chirli-delayed-public-')),database=join(directory,'test.sqlite'),secret=generateSecretKey(),author=localNip17Identity(),network=new MemoryRelay(),source='ws://source.invalid',write='ws://write.invalid',published:{event:Event;relays:string[]}[]=[];
 const transport=()=>{const wire=network.transport();return{...wire,publish:async(relays:string[],event:Event)=>{published.push({event:copy(event),relays:[...relays]});await wire.publish(relays,event);}};};
 const make=()=>new Bot({signer:nsecSigner(secret),database,relays:urls,writeRelays:[write],publicInbox:{relays:[source]},transport:transport()});
 let bot=make(),saved:Event|Rumor|undefined,contextThread:unknown;
 const register=()=>bot.command({command:'ping',scopes:['kind:1','kind:1111']},async ctx=>{saved=copy(ctx.input.event);contextThread=await ctx.thread({limit:10});await ctx.reply('context reply');});register();
 try{await bot.start();const root=await author.sign({kind:1,created_at:1,tags:[],content:'root'});await network.transport().publish([source],root);
  const target=kind===1?await author.sign({kind:1,created_at:2,tags:[['e',root.id,'','root']],content:`/ping@nostr:${npubEncode(bot.pubkey)}`}):await author.sign(commentReply(root,{id:root.id,kind:'1',author:root.pubkey},`/ping@${npubEncode(bot.pubkey)}`));
  assert.equal(await bot.receive(target,'live',{relay:source}),true);await bot.idle();assert.ok(saved);assert.deepEqual(await bot.thread(saved!,{limit:10}),contextThread);
  const result=await bot.reply(saved!,'after handler',{});assert.equal(result.status,'relay-accepted');assert.equal(published.at(-1)!.event.kind,1111);assert.deepEqual(new Set(published.at(-1)!.relays.map(url=>new URL(url).origin)),new Set([source,write]));assert.equal(threadStructure(published.at(-1)!.event).parent?.id,target.id);
  await bot.close();bot=make();register();await bot.start();const before=published.length;assert.equal(await bot.receive(target,'live',{relay:source}),false);assert.deepEqual(await bot.thread(copy(saved!),{limit:10}),contextThread);await bot.reply(copy(saved!),'after restart');assert.equal(published.length,before+1);assert.equal(threadStructure(published.at(-1)!.event).root?.id,root.id);assert.deepEqual(new Set(published.at(-1)!.relays.map(url=>new URL(url).origin)),new Set([source,write]));
  await assert.rejects(bot.reply(saved!,'invalid',{replyTo:target.id}),/DM send options/);await assert.rejects(bot.thread(saved!,{limit:101}),/limit/);
  // An unseen signed event cannot invent source provenance through its relay hint.
  const unseen=await author.sign({kind:1,created_at:4,content:'unseen',tags:[['p',bot.pubkey,'wss://untrusted.invalid'],['relay','wss://untrusted.invalid']]});await bot.reply(unseen,'explicit application reply');assert.deepEqual(published.at(-1)!.relays,[write]);
 }finally{await bot.close();await rm(directory,{recursive:true,force:true});}
});

test('unsigned/altered DM input, wrong accounts, IDs, wrappers and invalid public signatures are rejected before effects',async()=>{
 const network=new MemoryRelay(),peer=localNip17Identity(),make=()=>new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',relays:urls,publicInbox:{relays:urls},transport:network.transport()}),bot=make(),wrong=make();
 let saved:Event|Rumor|undefined;bot.handle(ctx=>{saved=copy(ctx.input.event);});
 try{await bot.start();await wrong.start();const original=rumor(peer.pubkey,bot.pubkey,'private'),outer=await wrap(original,peer,bot.pubkey,bot.pubkey,standardEnvelope);await bot.receive(outer,'live',{relay:urls[0]});await bot.idle();assert.ok(saved);
  const changed=copy(saved!);changed.content='altered';const rehashed={...changed,id:getEventHash(changed)};
  const recipient=copy(saved!);recipient.tags=[['p',wrong.pubkey]];const recipientHash={...recipient,id:getEventHash(recipient)};
  for(const event of [saved!.id,outer,changed,rehashed,recipient,recipientHash,{...saved!,sig:'0'.repeat(128)},rumor(peer.pubkey,bot.pubkey,'never received')]){await assert.rejects(bot.reply(event as never,'must not send'));await assert.rejects(bot.thread(event as never));}
  await assert.rejects(wrong.reply(saved!,'wrong account'),/authenticated incoming/);await assert.rejects(wrong.thread(saved!),/authenticated incoming/);
  const signed=await peer.sign({kind:1,created_at:1,tags:[],content:'public'});for(const event of [{...signed,content:'changed'},{...signed,sig:'0'.repeat(128)}]){await assert.rejects(bot.reply(event,'must not send'),/valid signed/);await assert.rejects(bot.thread(event),/valid signed/);}
  assert.equal(bot.history(peer.pubkey).messages.filter(message=>message.direction==='outgoing').length,0);assert.equal(wrong.history(peer.pubkey).messages.length,0);
 }finally{await bot.close();await wrong.close();}
});

test('context and delayed methods capture safe snapshots before caller mutation',async()=>{
 const network=new MemoryRelay(),wire=network.transport(),author=localNip17Identity(),published:Event[]=[];
 const bot=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',relays:urls,publicInbox:{relays:urls},transport:{...wire,publish:async(relays,event)=>{published.push(event);await wire.publish(relays,event);}}});let saved:Event|Rumor|undefined;
 bot.command({command:'ping',scopes:['kind:1']},async ctx=>{saved=copy(ctx.input.event);ctx.input.event.content='mutated';await ctx.reply('safe context');});
 try{await bot.start();const event=await author.sign({kind:1,created_at:1,tags:[['p',bot.pubkey]],content:'/ping'});await bot.receive(event,'live',{relay:urls[0]});await bot.idle();assert.equal(published.filter(event=>event.kind===1111).length,1);
  const request=copy(saved!);const task=bot.reply(request,'safe delayed');request.content='changed after call';request.tags.length=0;await task;assert.equal(threadStructure(published.at(-1)!).parent?.id,event.id);
  await assert.rejects(bot.reply(request,'mutated before call'),/valid signed/);
 }finally{await bot.close();}
});
