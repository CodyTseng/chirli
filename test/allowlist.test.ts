import {z} from 'zod';
import { localIdentity, localNip17Identity } from '../src/protocol.js';
import { identityFromSigner } from '../src/signers.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getEventHash, matchFilter, nip44, type Event } from 'nostr-tools';
import { allowlist, bunkerSigner, generateSecretKey, sqliteMessageStorage, getPublicKey, WebSocketTransport, type Transport } from '../src/index.js';
import { BotHandlers as Bot } from '../src/bot-handlers.js';
import { compatibilityEnvelope, rumor, splitEnvelope, standardEnvelope, unwrap, wrap } from '../src/protocol.js';
import { testRelay } from './relay.js';
import { mockBunker } from './bunker.js';
import { JsonMessageStorage } from '../examples/_json-storage.js';
const urls=['ws://memory.invalid'];
const silent:Transport={query:async()=>[],publish:async()=>{},close(){},subscribe:()=>({ready:Promise.resolve(),close(){}})};
const config=(identity=localNip17Identity())=>({identity,relays:urls,transport:silent,database:':memory:',storageKey:generateSecretKey()});
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timeout');}

for(const mode of ['nip17','nip4e'] as const)for(const protocol of ['standard','extension'] as const){
 test(`${mode}/${protocol}: allow only authenticated identities before listeners, commands, session and storage`,async()=>{
  const identity=localNip17Identity(),allowed=localIdentity(),denied=localIdentity();
  const sessions = new Map<string, Partial<{ count: number }>>();
  const client = new Client({ ...config(identity), mode });
  const bot = new Bot(client, {
    sessionStore: {
      get(peer: string) { sessionReads++; return sessions.get(peer); },
      set(peer: string, value: Partial<{ count: number }>) { sessions.set(peer, value); },
    },
  });
  bot.use(allowlist([allowed.pubkey]));
  let commands=0,listeners=0,middleware=0,sessionReads=0,errors=0;
  client.handle(()=>{listeners++;});client.onError(()=>{errors++;});bot.use(async(_ctx,next)=>{middleware++;await next();});bot.command({command:"run",title:"run",description:"Run /run in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})},async ctx=>{commands++;ctx.session.setItem('count',(await ctx.session.getItem('count') ?? 0)+1);});
  const policy=protocol==='standard'?standardEnvelope:splitEnvelope;
  const recipient=protocol==='standard'?identity.pubkey:client.encryptionKeys().currentPublicKey;
  try{
   await bot.start();
   for(const source of ['history','live'] as const){
    const event=await wrap(rumor(denied.pubkey,identity.pubkey,'/run '+source),denied,identity.pubkey,recipient,policy);
    assert.equal(await client.receive({...event,sender:allowed.pubkey} as Event,source),true);
    assert.equal(await client.receive(event,source),false);assert.equal(await client.receive(event,'live'),false);
   }
   await client.idle();assert.deepEqual([commands,listeners,middleware,sessionReads,errors],[0,0,0,0,0]);assert.equal(sessions.get(denied.pubkey),undefined);assert.equal(client.store.evidence(denied.pubkey),undefined);assert.equal(client.store.isSplitPeer(denied.pubkey),false);assert.equal(client.history(denied.pubkey).messages.length,0);assert.equal(client.store.pending().length,0);
   const event=await wrap(rumor(allowed.pubkey,identity.pubkey,'/run'),allowed,identity.pubkey,recipient,policy);
   assert.notEqual(event.pubkey,allowed.pubkey,'anonymous giftwrap author is not the sender');assert.equal(await client.receive(event,'live'),true);await client.idle();
   assert.deepEqual([commands,listeners,middleware,sessionReads],[1,1,1,1]);assert.equal(sessions.get(allowed.pubkey)?.count,1);
   assert.equal(await client.receive(event,'live'),false);await client.idle();assert.equal(commands,1);
   const recovered=rumor(allowed.pubkey,identity.pubkey,'/run recovered');
   const recoveredWrap=await wrap(recovered,allowed,identity.pubkey,recipient,policy);
   assert.equal(await client.receive(recoveredWrap,'history'),true);await client.idle();
   assert.deepEqual([commands,listeners,middleware,sessionReads],[2,2,2,2]);assert.equal(sessions.get(allowed.pubkey)?.count,2);
   assert.equal(client.getMessage(recovered.id)?.source,'history');
   assert.equal(await client.receive(recoveredWrap,'live'),false);await client.idle();assert.equal(commands,2);
  }finally{await bot.client.close(); bot.dispose();}
 });
}

test('omitting allowlist admits live DM history, while an empty allowlist blocks external payloads but not own copies',async()=>{
 const identity=localNip17Identity(),sender=localNip17Identity();
 const hello=()=>wrap(rumor(sender.pubkey,identity.pubkey,'hello'),sender,identity.pubkey,identity.pubkey,standardEnvelope);
 const client=new Client(config(identity));
 try{await client.start();assert.equal(await client.receive(await hello(),'live'),true);await client.idle();assert.equal(client.history(sender.pubkey).messages.length,1);}finally{await client.close();}
 const denyAll=new Client(config(identity)), bot=new Bot(denyAll);bot.use(allowlist([]));try{
  await bot.start();assert.equal(await denyAll.receive(await hello(),'live'),true);await denyAll.idle();
  assert.equal(denyAll.history(sender.pubkey).messages.length,0);
  const own=await wrap(rumor(identity.pubkey,sender.pubkey,'own outgoing'),identity,identity.pubkey,identity.pubkey,standardEnvelope);
  assert.equal(await denyAll.receive(own,'history'),true,'own copies are outgoing bookkeeping, never incoming handlers');assert.equal(denyAll.history(sender.pubkey).messages[0].direction,'outgoing');
 }finally{bot.dispose();await denyAll.close();}
});

test('encryption-key and anonymous wrapper keys never substitute for identity; forged identity bindings fail closed',async t=>{
 const now=Date.now();t.mock.method(Date,'now',()=>now);
 const victimSecret=generateSecretKey(),victim=localNip17Identity(victimSecret),attacker=localIdentity(),receiver=localNip17Identity();
 const r=rumor(attacker.pubkey,receiver.pubkey,'/run'),ordinary=await wrap(r,attacker,receiver.pubkey,receiver.pubkey);
 const encryption=(value:unknown,key:Uint8Array,peer:string)=>nip44.v2.encrypt(JSON.stringify(value),nip44.v2.utils.getConversationKey(key,peer));
 const outer=(seal:Event,key=generateSecretKey())=>finalizeEvent({kind:1059,created_at:r.created_at,tags:[['p',receiver.pubkey]],content:encryption(seal,key,receiver.pubkey)},key);
 const attackerSeal=await attacker.sign({kind:13,created_at:r.created_at,tags:[['n',getPublicKey(attacker.encryptionKey)]],content:encryption(r,attacker.encryptionKey,receiver.pubkey)});
 for(const allowedKey of [getPublicKey(attacker.encryptionKey),ordinary.pubkey]){
  const client=new Client(config(receiver)),bot=new Bot(client);bot.use(allowlist([allowedKey]));try{await bot.start();assert.equal(await client.receive(ordinary,'live'),true);await client.idle();assert.equal(client.history(attacker.pubkey).messages.length,0);}finally{bot.dispose();await client.close();}
 }
 const client=new Client(config(receiver)),bot=new Bot(client);bot.use(allowlist([victim.pubkey]));
 try{
  await bot.start();
  // A valid outer signature by the allowlisted key authenticates only the anonymous transport wrapper.
  assert.equal(await client.receive(outer(attackerSeal,victimSecret),'live'),true);
  await client.idle();
  // Even n equal to an allowed identity does not authenticate the seal's different identity author.
  const nVictim=await attacker.sign({kind:13,created_at:r.created_at,tags:[['n',victim.pubkey]],content:encryption(r,victimSecret,receiver.pubkey)});
  assert.equal(await client.receive(outer(nVictim),'live'),false);
  const impersonated={...r,pubkey:victim.pubkey};impersonated.id=getEventHash(impersonated);
  const forged=await attacker.sign({kind:13,created_at:r.created_at,tags:[['n',getPublicKey(attacker.encryptionKey)]],content:encryption(impersonated,attacker.encryptionKey,receiver.pubkey)});
  for(const event of [outer(forged),outer({...attackerSeal,pubkey:victim.pubkey}),{...ordinary,sig:'0'.repeat(128)}])assert.equal(await client.receive(event,'live'),false);
  const malformed=await victim.sign({kind:13,created_at:r.created_at,tags:[['n','invalid'],['n',victim.pubkey]],content:encryption(impersonated,victimSecret,receiver.pubkey)});assert.equal(await client.receive(outer(malformed),'live'),false);
  assert.equal(client.history(attacker.pubkey).messages.length,0);assert.equal(client.history(victim.pubkey).messages.length,0);assert.equal(client.store.evidence(victim.pubkey),undefined);
 }finally{bot.dispose();await client.close();}
});

for(const [name,Adapter] of [['SQLite',sqliteMessageStorage],['custom',(path: string) => new JsonMessageStorage(path)]] as const){
 test(`${name}: failed and rejected input claims survive restarts without running handlers again`,async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  const dir=await mkdtemp(join(tmpdir(),'chirli-allowlist-')),path=join(dir,'state'),identity=localNip17Identity(),sender=localNip17Identity(),storageKey=generateSecretKey();let storage=Adapter(path);
  const options={identity,storageKey,database:join(dir,'core.sqlite'),messageStorage:storage,relays:urls,transport:silent};let client=new Client(options);let attempts=0,sessionReads=0;
  const accepted=await wrap(rumor(sender.pubkey,identity.pubkey,'/run accepted before restriction'),sender,identity.pubkey,identity.pubkey,standardEnvelope);
  const denied=await wrap(rumor(sender.pubkey,identity.pubkey,'/run denied at intake'),sender,identity.pubkey,identity.pubkey,standardEnvelope);
  try{
   client.handle(()=>{attempts++;throw new Error('unfinished work');});await client.start();await client.receive(accepted,'live');await client.idle();assert.equal(client.store.pending().length,1);await client.close();if ('close' in storage) storage.close();storage=Adapter(path);
   client=new Client({...options,messageStorage:storage});const bot=new Bot(client,{sessionStore:{get(){sessionReads++;return undefined;},set(){}}});bot.use(allowlist([]));bot.command({command:"run",title:"run",description:"Run /run in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})},async ctx=>{await ctx.session.getItem('count');attempts++;});client.handle(()=>{attempts++;});await client.start();await client.idle();
   assert.equal(attempts,1);assert.equal(sessionReads,0);assert.equal(client.history(sender.pubkey).messages.length,1,'previously accepted encrypted history remains readable');
   assert.equal(await client.receive(denied,'live'),true);assert.equal(await client.receive(denied,'history'),false);await client.idle();assert.equal(client.history(sender.pubkey).messages.length,1);await bot.client.close(); bot.dispose();if ('close' in storage) storage.close();storage=Adapter(path);
   client=new Client({...options,messageStorage:storage});client.handle(()=>{attempts++;});await client.start();assert.equal(attempts,1,'revoked pending work stays consumed even if allowed later');
   assert.equal(await client.receive(accepted,'live'),false,'retained accepted receipt deduplicates');assert.equal(await client.receive(denied,'history'),false);assert.equal(await client.receive(denied,'live'),false,'original claim deduplicates later live despite the new allowlist');await client.idle();assert.equal(attempts,1);
  }finally{await client.close();if ('close' in storage) storage.close();await rm(dir,{recursive:true,force:true});}
 });
}

test('managed recovery runs allowed DMs once but never exposes denied or preactivation payloads',async()=>{
 const relay=await testRelay(),identity=localNip17Identity(),allowed=localNip17Identity(),denied=localIdentity(),wire=new WebSocketTransport();
 const client=new Client({identity,relays:[relay.url],transport:new WebSocketTransport(500,t=>identity.sign(t)),database:':memory:',storageKey:generateSecretKey(),reconnect:{initialDelayMs:30,maxDelayMs:60,jitter:0}});
 const bot=new Bot(client);bot.use(allowlist([allowed.pubkey]));
 let calls=0;client.handle(()=>{calls++;});client.onError(()=>{});
 try{
  await client.announce();
  const beforeActivation=await wrap(rumor(allowed.pubkey,identity.pubkey,'/preactivation',Date.now()-1000),allowed,identity.pubkey,identity.pubkey,standardEnvelope);
  await wire.publish([relay.url],beforeActivation);await client.start();await client.idle();
  assert.equal(calls,0,'an allowed sender cannot make preactivation DMs run');assert.equal(client.history(allowed.pubkey).messages.length,0);assert.ok(client.store.checkpoint(relay.url));
  const initialConnections=relay.connections;relay.pauseReads(true);relay.disconnect();await new Promise(r=>setTimeout(r,50));
  const deniedDuringDowntime=await wrap(rumor(denied.pubkey,identity.pubkey,'/denied downtime'),denied,identity.pubkey,identity.pubkey);
  await wire.publish([relay.url],deniedDuringDowntime);
  const recovered=await wrap(rumor(allowed.pubkey,identity.pubkey,'/allowed downtime'),allowed,identity.pubkey,identity.pubkey,standardEnvelope);
  await wire.publish([relay.url],recovered);
  relay.pauseReads(false);await until(()=>relay.connections>initialConnections);
  let recoveredWindow=false;
  for(let i=0;i<100&&!recoveredWindow;i++){
   const results=await client.syncHistory();
   recoveredWindow=results.some(result=>result.status==='window-complete');
   if(!recoveredWindow)await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(recoveredWindow,true);await client.idle();assert.equal(await client.receive(recovered,'live'),false);
  assert.equal(await client.receive(deniedDuringDowntime,'live'),false,'recovered denial is already claimed');
  assert.deepEqual(client.history(allowed.pubkey).messages.map(({text,source})=>[text,source]),[['/allowed downtime','history']]);assert.equal(calls,1);assert.equal(client.history(denied.pubkey).messages.length,0);
  await wire.publish([relay.url],await wrap(rumor(allowed.pubkey,identity.pubkey,'/allowed live'),allowed,identity.pubkey,identity.pubkey,standardEnvelope));await until(()=>calls===2);await client.syncHistory();await client.idle();assert.equal(calls,2);assert.equal(client.history(denied.pubkey).messages.length,0);
 }finally{bot.dispose();await client.close();wire.close();await relay.close();}
});

test('bunker-backed intake applies the identity allowlist after async decryption in both modes and protocols',async()=>{
 const remote=await mockBunker(),signer=bunkerSigner(remote.uri,{clientSecret:generateSecretKey(),timeoutMs:1000}),identity=await identityFromSigner(signer),allowed=localIdentity(),denied=localIdentity();
 try{
  for(const mode of ['nip17','nip4e'] as const){
   const client=new Client({mode,identity,relays:urls,transport:silent,database:':memory:',storageKey:generateSecretKey()});const bot=new Bot(client);bot.use(allowlist([allowed.pubkey]));let calls=0;client.handle(()=>{calls++;});
   try{
    await client.start();
    for(const policy of [standardEnvelope,splitEnvelope]){
     const key=policy===standardEnvelope?identity.pubkey:client.encryptionKeys().currentPublicKey;
     assert.equal(await client.receive(await wrap(rumor(denied.pubkey,identity.pubkey,'denied remote'),denied,identity.pubkey,key,policy),'live'),true);
     assert.equal(await client.receive(await wrap(rumor(allowed.pubkey,identity.pubkey,'allowed remote'),allowed,identity.pubkey,key,policy),'live'),true);
    }
    await client.idle();assert.equal(calls,2);assert.equal(client.history(denied.pubkey).messages.length,0);assert.equal(identity.encryptionKey,undefined);
   }finally{bot.dispose();await client.close();}
  }
 }finally{await signer.close();await remote.close();}
});

for(const useNewer of [false,true]){
 test(`pre-next middleware reply uses ${useNewer?'newer signed metadata':'ephemeral seal key'} without admitting the input`,async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const secret=generateSecretKey(),incoming=localIdentity(secret),rotated=localIdentity(secret),receiver=localNip17Identity();
  const r=rumor(incoming.pubkey,receiver.pubkey,'do not store this payload',now);
  const declaration=await incoming.sign({kind:10044,created_at:r.created_at+1,content:'',tags:[['n',getPublicKey(rotated.encryptionKey)]]});
  const wire:Event[]=[];
  const transport:Transport={...silent,
   query:async(_relays,filter)=>useNewer&&matchFilter(filter,declaration)?[declaration]:[],
   publish:async(_relays,event)=>{wire.push(event);},
  };
  const client=new Client({...config(receiver),mode:'nip17',transport}),bot=new Bot(client);
  bot.use(async ctx=>{assert.deepEqual(client.history(ctx.sender).messages,[]);await ctx.reply('middleware reply');});
  bot.handle(()=>assert.fail('middleware stopped before routing'));
  try {
   await bot.start();now+=1000;
   const event=await wrap(r,incoming,receiver.pubkey,receiver.pubkey,splitEnvelope);
   assert.equal(await client.receive(event,'live'),true);await client.idle();
   const replies=wire.filter(event=>event.kind===1059&&event.tags.some(tag=>tag[0]==='p'&&tag[1]===incoming.pubkey));
   assert.equal(replies.length,1);
   assert.equal(unwrap(replies[0],useNewer?rotated:incoming,compatibilityEnvelope)?.rumor.content,'middleware reply');
   assert.equal(unwrap(replies[0],useNewer?incoming:rotated,compatibilityEnvelope),undefined);
   assert.deepEqual(client.history(incoming.pubkey).messages.map(message=>[message.direction,message.text]),[['outgoing','middleware reply']]);
   assert.equal(client.store.evidence(incoming.pubkey)?.key,useNewer?getPublicKey(rotated.encryptionKey):undefined);
   assert.equal(await client.receive(event,'history'),false);
  } finally {bot.dispose();await client.close();}
 });
}
