import {z} from 'zod';
import { localIdentity, localNip17Identity } from '../src/protocol.js';
import { identityFromSigner } from '../src/signers.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getEventHash, nip44, type Event } from 'nostr-tools';
import { allowlist, bunkerSigner, generateSecretKey, sqliteMessageStorage, getPublicKey, WebSocketTransport, type SenderAllowlist, type Transport } from '../src/index.js';
import { BotHandlers as Bot } from '../src/bot-handlers.js';
import { SQLiteStorage } from '../src/storage-sqlite.js';
import { rumor, splitEnvelope, standardEnvelope, wrap } from '../src/protocol.js';
import { testRelay } from './relay.js';
import { mockBunker } from './bunker.js';
import { JsonMessageStorage } from '../examples/_json-storage.js';
const urls=['ws://memory.invalid'];
const silent:Transport={query:async()=>[],publish:async()=>{},close(){},subscribe:()=>({ready:Promise.resolve(),close(){}})};
const config=(identity=localNip17Identity())=>({identity,relays:urls,transport:silent,database:':memory:',storageKey:generateSecretKey()});
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timeout');}

for(const option of ['legacy','policy'] as const)for(const mode of ['nip17','nip4e'] as const)for(const protocol of ['standard','extension'] as const){
 test(`${option}/${mode}/${protocol}: allow only authenticated identities before listeners, commands, session and storage`,async()=>{
  const identity=localNip17Identity(),allowed=localIdentity(),denied=localIdentity();
  const sessions = new Map<string, Partial<{ count: number }>>();
  const client = new Client({ ...config(identity), mode, ...(option==='legacy'?{allowlist:[allowed.pubkey]}:{inboundPolicy:allowlist([allowed.pubkey])}) });
  const bot = new Bot(client, {
    sessionStore: {
      get(peer: string) { sessionReads++; return sessions.get(peer); },
      set(peer: string, value: Partial<{ count: number }>) { sessions.set(peer, value); },
    },
  });
  let commands=0,listeners=0,middleware=0,sessionReads=0,errors=0;
  client.handle(()=>{listeners++;});client.onError(()=>{errors++;});bot.use(async(_ctx,next)=>{middleware++;await next();});bot.command({command:"run",title:"run",description:"Run /run in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})},async ctx=>{commands++;ctx.session.setItem('count',(await ctx.session.getItem('count') ?? 0)+1);});
  const policy=protocol==='standard'?standardEnvelope:splitEnvelope;
  const recipient=protocol==='standard'?identity.pubkey:client.encryptionKeys().currentPublicKey;
  try{
   await bot.start();
   for(const source of ['history','live'] as const){
    const event=await wrap(rumor(denied.pubkey,identity.pubkey,'/run'),denied,identity.pubkey,recipient,policy);
    assert.equal(await client.receive({...event,sender:allowed.pubkey} as Event,source),false);
    assert.equal(await client.receive(event,source),false);assert.equal(await client.receive(event,'live'),false);
   }
   await client.idle();assert.deepEqual([commands,listeners,middleware,sessionReads,errors],[0,0,0,0,0]);assert.equal(sessions.get(denied.pubkey),undefined);assert.equal(client.store.evidence(denied.pubkey),undefined);assert.equal(client.store.isSplitPeer(denied.pubkey),false);assert.equal(client.history(denied.pubkey).messages.length,0);assert.equal(client.store.pending().length,0);
   const event=await wrap(rumor(allowed.pubkey,identity.pubkey,'/run'),allowed,identity.pubkey,recipient,policy);
   assert.notEqual(event.pubkey,allowed.pubkey,'anonymous giftwrap author is not the sender');assert.equal(await client.receive(event,'live'),true);await client.idle();
   assert.deepEqual([commands,listeners,middleware,sessionReads],[1,1,1,1]);assert.equal(sessions.get(allowed.pubkey)?.count,1);
   assert.equal(await client.receive(event,'live'),false);await client.retryInbox();assert.equal(commands,1);
   const old=await wrap(rumor(allowed.pubkey,identity.pubkey,'/run old'),allowed,identity.pubkey,recipient,policy);assert.equal(await client.receive(old,'history'),true);await client.idle();assert.equal(commands,1);
  }finally{await bot.client.close(); bot.dispose();}
 });
}

test('missing versus empty, invalid formats and immutable configuration snapshots',async()=>{
 const identity=localNip17Identity(),sender=localNip17Identity(),event=await wrap(rumor(sender.pubkey,identity.pubkey,'hello'),sender,identity.pubkey,identity.pubkey,standardEnvelope);
 for(const allowlist of [undefined,[]] as const){const client=new Client({...config(identity),allowlist});try{assert.equal(await client.receive(event,'history'),allowlist===undefined);}finally{await client.close();}}
 for(const allowlist of [null,'anything',['invalid'],[sender.pubkey.toUpperCase()],new Array(1)] as unknown[]){assert.throws(()=>new Client({...config(identity),allowlist:allowlist as SenderAllowlist}),/allowlist/);}
 const configured=[sender.pubkey],client=new Client({...config(identity),allowlist:configured});configured.splice(0,1,getPublicKey(generateSecretKey()));
 try{assert.equal(await client.receive(event,'history'),true);}finally{await client.close();}
 const denyAll=new Client({...config(identity),allowlist:[]});try{
  const own=await wrap(rumor(identity.pubkey,sender.pubkey,'own outgoing'),identity,identity.pubkey,identity.pubkey,standardEnvelope);
  assert.equal(await denyAll.receive(own,'history'),true,'own copies are outgoing bookkeeping, never incoming handlers');assert.equal(denyAll.history(sender.pubkey).messages[0].direction,'outgoing');
 }finally{await denyAll.close();}
});

test('encryption-key and anonymous wrapper keys never substitute for identity; forged identity bindings fail closed',async()=>{
 const victimSecret=generateSecretKey(),victim=localNip17Identity(victimSecret),attacker=localIdentity(),receiver=localNip17Identity();
 const r=rumor(attacker.pubkey,receiver.pubkey,'/run'),ordinary=await wrap(r,attacker,receiver.pubkey,receiver.pubkey);
 const encryption=(value:unknown,key:Uint8Array,peer:string)=>nip44.v2.encrypt(JSON.stringify(value),nip44.v2.utils.getConversationKey(key,peer));
 const outer=(seal:Event,key=generateSecretKey())=>finalizeEvent({kind:1059,created_at:r.created_at,tags:[['p',receiver.pubkey]],content:encryption(seal,key,receiver.pubkey)},key);
 const attackerSeal=await attacker.sign({kind:13,created_at:r.created_at,tags:[['n',getPublicKey(attacker.encryptionKey)]],content:encryption(r,attacker.encryptionKey,receiver.pubkey)});
 for(const allowedKey of [getPublicKey(attacker.encryptionKey),ordinary.pubkey]){
  const client=new Client({...config(receiver),inboundPolicy:allowlist([allowedKey])});try{assert.equal(await client.receive(ordinary,'live'),false);assert.equal(client.history(attacker.pubkey).messages.length,0);}finally{await client.close();}
 }
 const client=new Client({...config(receiver),inboundPolicy:allowlist([victim.pubkey])});
 try{
  // A valid outer signature by the allowlisted key authenticates only the anonymous transport wrapper.
  assert.equal(await client.receive(outer(attackerSeal,victimSecret),'live'),false);
  // Even n equal to an allowed identity does not authenticate the seal's different identity author.
  const nVictim=await attacker.sign({kind:13,created_at:r.created_at,tags:[['n',victim.pubkey]],content:encryption(r,victimSecret,receiver.pubkey)});
  assert.equal(await client.receive(outer(nVictim),'live'),false);
  const impersonated={...r,pubkey:victim.pubkey};impersonated.id=getEventHash(impersonated);
  const forged=await attacker.sign({kind:13,created_at:r.created_at,tags:[['n',getPublicKey(attacker.encryptionKey)]],content:encryption(impersonated,attacker.encryptionKey,receiver.pubkey)});
  for(const event of [outer(forged),outer({...attackerSeal,pubkey:victim.pubkey}),{...ordinary,sig:'0'.repeat(128)}])assert.equal(await client.receive(event,'live'),false);
  const malformed=await victim.sign({kind:13,created_at:r.created_at,tags:[['n','invalid'],['n',victim.pubkey]],content:encryption(impersonated,victimSecret,receiver.pubkey)});assert.equal(await client.receive(outer(malformed),'live'),false);
  assert.equal(client.history(attacker.pubkey).messages.length,0);assert.equal(client.history(victim.pubkey).messages.length,0);assert.equal(client.store.evidence(victim.pubkey),undefined);
 }finally{await client.close();}
});

for(const [name,Adapter] of [['SQLite',sqliteMessageStorage],['custom',(path: string) => new JsonMessageStorage(path)]] as const){
 test(`${name}: restart and retry consume revoked pending work; rejected history can later be stored without replay`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chirli-allowlist-')),path=join(dir,'state'),identity=localNip17Identity(),sender=localNip17Identity(),storageKey=generateSecretKey();let storage=Adapter(path);
  const options={identity,storageKey,database:join(dir,'core.sqlite'),messageStorage:storage,relays:urls,transport:silent};let client=new Client(options);let attempts=0,sessionReads=0;
  const accepted=await wrap(rumor(sender.pubkey,identity.pubkey,'/run accepted before restriction'),sender,identity.pubkey,identity.pubkey,standardEnvelope);
  const denied=await wrap(rumor(sender.pubkey,identity.pubkey,'/run denied at intake'),sender,identity.pubkey,identity.pubkey,standardEnvelope);
  try{
   client.handle(()=>{attempts++;throw new Error('unfinished work');});await client.start();await client.receive(accepted,'live');await client.idle();assert.equal(client.store.pending().length,1);await client.close();if ('close' in storage) storage.close();storage=Adapter(path);
   client=new Client({...options,messageStorage:storage,inboundPolicy:allowlist([])});const bot=new Bot(client,{sessionStore:{get(){sessionReads++;return undefined;},set(){}}});bot.command({command:"run",title:"run",description:"Run /run in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})},async ctx=>{await ctx.session.getItem('count');attempts++;});client.handle(()=>{attempts++;});await client.start();await client.retryInbox();
   assert.equal(attempts,1);assert.equal(sessionReads,0);assert.equal(client.store.pending().length,0);assert.equal(client.history(sender.pubkey).messages.length,1,'previously accepted encrypted history remains readable');
   assert.equal(await client.receive(denied,'live'),false);assert.equal(await client.receive(denied,'history'),false);await bot.client.close(); bot.dispose();if ('close' in storage) storage.close();storage=Adapter(path);
   client=new Client({...options,messageStorage:storage,inboundPolicy:allowlist([sender.pubkey])});client.handle(()=>{attempts++;});await client.start();assert.equal(attempts,1,'revoked pending work stays consumed even if allowed later');
   assert.equal(await client.receive(accepted,'live'),false,'retained accepted receipt deduplicates');assert.equal(await client.receive(denied,'history'),true);assert.equal(await client.receive(denied,'live'),false,'first newly permitted historical receipt deduplicates later live');await client.idle();assert.equal(attempts,1);
  }finally{await client.close();if ('close' in storage) storage.close();await rm(dir,{recursive:true,force:true});}
 });
}

test('managed history/reconnect checks the same identity policy without persisting or replaying rejected commands',async()=>{
 const relay=await testRelay(),identity=localNip17Identity(),allowed=localNip17Identity(),denied=localIdentity(),wire=new WebSocketTransport();
 const client=new Client({identity,inboundPolicy:allowlist([allowed.pubkey]),relays:[relay.url],transport:new WebSocketTransport(500,t=>identity.sign(t)),database:':memory:',storageKey:generateSecretKey(),reconnect:{initialDelayMs:30,maxDelayMs:60,jitter:0}});
 let calls=0;client.handle(()=>{calls++;});client.onError(()=>{});
 try{
  await client.announce();const rejected=await wrap(rumor(denied.pubkey,identity.pubkey,'/denied history'),denied,identity.pubkey,identity.pubkey);await wire.publish([relay.url],rejected);await client.start();
  assert.equal(client.history(denied.pubkey).messages.length,0);assert.ok(client.store.checkpoint(relay.url));
  const initialConnections=relay.connections;relay.pauseReads(true);relay.disconnect();await new Promise(r=>setTimeout(r,50));
  await wire.publish([relay.url],await wrap(rumor(denied.pubkey,identity.pubkey,'/denied downtime'),denied,identity.pubkey,identity.pubkey));
  await wire.publish([relay.url],await wrap(rumor(allowed.pubkey,identity.pubkey,'/allowed downtime'),allowed,identity.pubkey,identity.pubkey,standardEnvelope));
  relay.pauseReads(false);await until(()=>client.history(allowed.pubkey).messages.length===1);assert.ok(relay.connections>initialConnections);await client.idle();assert.equal(calls,0);assert.equal(client.history(denied.pubkey).messages.length,0);
  await wire.publish([relay.url],await wrap(rumor(allowed.pubkey,identity.pubkey,'/allowed live'),allowed,identity.pubkey,identity.pubkey,standardEnvelope));await until(()=>calls===1);await client.syncHistory();await client.idle();assert.equal(calls,1);assert.equal(client.history(denied.pubkey).messages.length,0);
 }finally{await client.close();wire.close();await relay.close();}
});

test('bunker-backed intake applies the identity allowlist after async decryption in both modes and protocols',async()=>{
 const remote=await mockBunker(),signer=bunkerSigner(remote.uri,{clientSecret:generateSecretKey(),timeoutMs:1000}),identity=await identityFromSigner(signer),allowed=localIdentity(),denied=localIdentity();
 try{
  for(const mode of ['nip17','nip4e'] as const){
   const client=new Client({mode,identity,inboundPolicy:allowlist([allowed.pubkey]),relays:urls,transport:silent,database:':memory:',storageKey:generateSecretKey()});let calls=0;client.handle(()=>{calls++;});
   try{
    await client.start();
    for(const policy of [standardEnvelope,splitEnvelope]){
     const key=policy===standardEnvelope?identity.pubkey:client.encryptionKeys().currentPublicKey;
     assert.equal(await client.receive(await wrap(rumor(denied.pubkey,identity.pubkey,'denied remote'),denied,identity.pubkey,key,policy),'live'),false);
     assert.equal(await client.receive(await wrap(rumor(allowed.pubkey,identity.pubkey,'allowed remote'),allowed,identity.pubkey,key,policy),'live'),true);
    }
    await client.idle();assert.equal(calls,2);assert.equal(client.history(denied.pubkey).messages.length,0);assert.equal(identity.encryptionKey,undefined);
   }finally{await client.close();}
  }
 }finally{await signer.close();await remote.close();}
});
