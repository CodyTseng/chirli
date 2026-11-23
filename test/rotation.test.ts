import {z} from 'zod';
import { localIdentity, localNip17Identity, type Identity } from '../src/protocol.js';
import { identityFromSigner } from '../src/signers.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchFilter, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { nsecEncode } from 'nostr-tools/nip19';
import { nsecSigner, bunkerSigner, generateSecretKey, getPublicKey, Nip4eCompatibilityError, type ProtocolMode, type Transport } from '../src/index.js';
import { BotHandlers as Bot } from '../src/bot-handlers.js';
import { identityMessagingKey, rumor, splitEnvelope, standardEnvelope, unwrap, wrap } from '../src/protocol.js';
import { mockBunker } from './bunker.js';
class Relay {
 events=new Map<string,Event>();attempts:Event[]=[];fail=false;acceptBeforeFailure=false;
 listeners=new Set<{filter:Filter;receive:(event:Event,source:'live'|'history')=>void}>();
 transport():Transport{const owned=new Set<()=>void>();return{
 query:async(_relays,filter)=>[...this.events.values()].filter(e=>matchFilter(filter,e)),
 subscribe:(_relays,filter,receive)=>{for(const e of this.events.values())if(matchFilter(filter,e))receive(structuredClone(e),'history');const listener={filter,receive};this.listeners.add(listener);const close=()=>{this.listeners.delete(listener);owned.delete(close);};owned.add(close);return{ready:Promise.resolve(),close};},
 publish:async(_relays,event)=>{assert.ok(verifyEvent(structuredClone(event)));this.attempts.push(structuredClone(event));if(this.fail&&!this.acceptBeforeFailure)throw new Error('test ACK failure');if(!this.events.has(event.id)){this.events.set(event.id,structuredClone(event));for(const l of this.listeners)if(matchFilter(l.filter,event))l.receive(structuredClone(event),'live');}if(this.fail)throw new Error('test ACK lost');},
 close:()=>{for(const close of owned)close();},
 };}
}
const relays=['ws://memory.invalid'];
const options=<Mode extends ProtocolMode|undefined=undefined>(identity:Identity,relay:Relay,mode:Mode=undefined as Mode)=>({identity,mode,keySync:false as const,relays,transport:relay.transport(),database:':memory:',storageKey:generateSecretKey()});
async function drain(...clients:Client[]){for(let i=0;i<8;i++){for(const c of clients)await c.idle();await new Promise<void>(r=>setImmediate(r));}}
async function until(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timeout');}

for(const mode of ['nip17','nip4e'] as const)for(const signerKind of ['local','nsec','bunker'] as const){
 test(`${mode}/${signerKind}: same Bot handles standard identity recipients and split-key recipients`,async()=>{
  const remote=signerKind==='bunker'?await mockBunker():undefined;
  const signer=remote?bunkerSigner(remote.uri,{clientSecret:generateSecretKey(),timeoutMs:1000}):signerKind==='nsec'?nsecSigner(nsecEncode(generateSecretKey())):undefined;
  const identity=signer?await identityFromSigner(signer):localNip17Identity(),relay=new Relay();
  const client=new Client(options(identity,relay,mode)),standard=localNip17Identity(),split=localIdentity(),wire=relay.transport();
  const failures:unknown[]=[];client.onError(e=>{failures.push(e);});const bot=new Bot(client);let calls=0;
  bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})},async ctx=>{calls++;await ctx.reply(`pong ${calls}`);});
  try{
   await client.announce();
   for(const peer of [standard,split])await wire.publish(relays,await peer.sign({kind:10050,created_at:10,tags:[['relay',relays[0]]],content:''}));
   await wire.publish(relays,await split.sign({kind:10044,created_at:10,tags:[['n',getPublicKey(split.encryptionKey)]],content:''}));
   await bot.start();
   const standardEvent=await wrap(rumor(standard.pubkey,identity.pubkey,'/ping'),standard,identity.pubkey,identity.pubkey,standardEnvelope);
   const splitToIdentity=await wrap(rumor(split.pubkey,identity.pubkey,'/ping'),split,identity.pubkey,identity.pubkey,splitEnvelope);
   const splitToCurrent=await wrap(rumor(split.pubkey,identity.pubkey,'/ping'),split,identity.pubkey,client.encryptionKeys().currentPublicKey,splitEnvelope);
   for(const event of [standardEvent,splitToIdentity,splitToCurrent])await wire.publish(relays,event);
   await drain(client);assert.equal(calls,3);assert.deepEqual(failures,[]);
   const replies=[...relay.events.values()].filter(e=>e.kind===1059&&e.tags[0][1]!==identity.pubkey);
   const standardReply=replies.find(e=>e.tags[0][1]===standard.pubkey)!;
   assert.ok(unwrap(standardReply,standard,standardEnvelope));
   const splitReplies=replies.filter(e=>e.tags[0][1]===split.pubkey);
   assert.equal(splitReplies.length,2);for(const reply of splitReplies)assert.equal(unwrap(reply,split,splitEnvelope)?.encryptionPubkey,client.encryptionKeys().currentPublicKey);
   if(remote){assert.equal(identity.pubkey,remote.accountPubkey);assert.notEqual(identity.pubkey,remote.transportPubkey);}
   if(mode==='nip4e'){
    const before=client.encryptionKeys().currentPublicKey;await client.rotateEncryptionKey();assert.notEqual(client.encryptionKeys().currentPublicKey,before);
    const late=await wrap(rumor(split.pubkey,identity.pubkey,'/ping'),split,identity.pubkey,before);
    await wire.publish(relays,late);await drain(client);assert.equal(calls,4);
   }
  }finally{await bot.client.close(); bot.dispose();await signer?.close();await remote?.close();}
 });
}

test('new default is identity-key, split opt-in generates a separate persistent key; invalid configurations fail',async()=>{
 const relay=new Relay(),identity=localNip17Identity(),client=new Client(options(identity,relay));
 try{assert.equal(client.mode,'nip17');assert.equal(client.encryptionKeys().currentPublicKey,identity.pubkey);await assert.rejects(client.rotateEncryptionKey(),/nip4e/);}finally{await client.close();}
 assert.throws(()=>new Client({...options(identity,relay),keyRotation:{intervalMs:1000}} as never),/explicit mode/);
 for(const rotation of [{intervalMs:0},{intervalMs:1000,retainLegacyKeys:0},{intervalMs:1000,legacyMaxAgeMs:1}])assert.throws(()=>new Client({...options(identity,relay,'nip4e'),keyRotation:rotation}));
 const split=new Client({...options(identity,relay,'nip4e'),nip4eCompatibility:false});try{assert.notEqual(split.encryptionKeys().currentPublicKey,identity.pubkey);assert.equal(split.nip4eCompatibility,true);}finally{await split.close();}
 assert.throws(()=>new Client(options({...localIdentity(),identityEncryption:undefined},relay,'nip4e')),/identity-key/);
});

test('rotation stages a durable decryptable key before ACK, coalesces calls, resumes exact declaration and preserves queued messages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chirli-rotation-')),relay=new Relay(),identity=localNip17Identity(),storageKey=generateSecretKey();
 const config={...options(identity,relay,'nip4e'),database:join(dir,'state.db'),storageKey};let client=new Client(config);
 const peer=localIdentity(),oldKey=client.encryptionKeys().currentPublicKey;
 try{
  await client.announce();
  // A message already staged for retry must retain its encrypted bytes through rotation.
  const r=rumor(identity.pubkey,peer.pubkey,'persisted outbound'),event=await wrap(r,Reflect.get(client, 'account'),peer.pubkey,getPublicKey(peer.encryptionKey));
  client.store.putOutbox(r.id,[{event,relays}]);relay.fail=true;relay.acceptBeforeFailure=true;
  const first=client.rotateEncryptionKey(),second=client.rotateEncryptionKey();await assert.rejects(first,/ACK/);await assert.rejects(second,/ACK/);
  const status=client.encryptionKeys();assert.equal(status.currentPublicKey,oldKey);assert.ok(status.pending);const pending=status.pending!;
  assert.ok(status.decryptionPublicKeys.includes(pending.publicKey));
  const arriving=await wrap(rumor(peer.pubkey,identity.pubkey,'new key before ACK'),peer,identity.pubkey,pending.publicKey);
  assert.equal(await client.receive(arriving,'history'),true);
  await client.close();client=new Client({...config,transport:relay.transport()});assert.equal(client.encryptionKeys().pending?.eventId,pending.eventId);
  assert.equal(await client.receive(await wrap(rumor(peer.pubkey,identity.pubkey,'after restart pending'),peer,identity.pubkey,pending.publicKey),'history'),true);
  relay.fail=false;await client.start();
  assert.equal(client.encryptionKeys().currentPublicKey,pending.publicKey);assert.equal(client.encryptionKeys().pending,undefined);
  assert.equal(client.encryptionKeys().legacy[0].publicKey,oldKey);
  const attempts=relay.attempts.filter(e=>e.kind===10044&&e.tags[0][1]===pending.publicKey);assert.ok(attempts.length>=2);assert.ok(attempts.every(e=>e.id===pending.eventId));
  assert.equal(relay.events.get(event.id)?.content,event.content);assert.equal(client.store.outbox().length,0);
  assert.equal(await client.receive(await wrap(rumor(peer.pubkey,identity.pubkey,'delayed old cache'),peer,identity.pubkey,oldKey),'history'),true);
  const splitSecret=Buffer.from(Reflect.get(client, 'account').encryptionKey!);await client.close();const bytes=await readFile(config.database);
  assert.ok(!bytes.includes(splitSecret));assert.ok(!bytes.includes(Buffer.from(splitSecret.toString('hex'))));
  assert.ok(!bytes.includes(Buffer.from('new key before ACK')));
  // Wrong storage keys fail authenticated recovery rather than resetting the keyring.
  assert.throws(()=>new Client({...config,transport:relay.transport(),storageKey:generateSecretKey()}));
 }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});

test('publication conflict and local persistence failure cannot overwrite or lose held keys',async()=>{
 const relay=new Relay(),identity=localNip17Identity(),client=new Client(options(identity,relay,'nip4e'));
 try{
  await client.announce();const before=client.encryptionKeys().currentPublicKey,count=relay.attempts.length;
  const save=client.store.saveKeyring.bind(client.store);let failing=true;
  client.store.saveKeyring=(...args)=>{if(failing)throw new Error('disk full');save(...args);};
  await assert.rejects(client.rotateEncryptionKey(),/disk full/);assert.equal(relay.attempts.length,count);assert.equal(client.encryptionKeys().currentPublicKey,before);
  failing=false;await client.rotateEncryptionKey();assert.notEqual(client.encryptionKeys().currentPublicKey,before);
  const claim=await identity.sign({kind:10044,created_at:Math.max(...[...relay.events.values()].map(e=>e.created_at))+1,tags:[['n',getPublicKey(generateSecretKey())]],content:''});await relay.transport().publish(relays,claim);
  const accepted=relay.attempts.length;await assert.rejects(client.rotateEncryptionKey(),Nip4eCompatibilityError);await assert.rejects(client.announce({replaceEncryptionKey:claim.tags[0][1]}),/locally available/);assert.equal(relay.attempts.length,accepted);
 }finally{await client.close();}
});

test('legacy count and retirement-age limits apply after successful rotation, not failed publication',async t=>{
 let now=Date.now();t.mock.method(Date,'now',()=>now);const relay=new Relay(),identity=localNip17Identity(),peer=localIdentity();
 const client=new Client({...options(identity,relay,'nip4e'),keyRotation:{intervalMs:1000,retainLegacyKeys:2,legacyMaxAgeMs:5000}});
 try{
  await client.announce();const keys=[client.encryptionKeys().currentPublicKey];
  for(let i=0;i<3;i++){now+=1100;await client.rotateEncryptionKey();keys.push(client.encryptionKeys().currentPublicKey);}
  assert.deepEqual(client.encryptionKeys().legacy.map(k=>k.publicKey),[keys[2],keys[1]]);
  assert.equal(await client.receive(await wrap(rumor(peer.pubkey,identity.pubkey,'evicted'),peer,identity.pubkey,keys[0]),'history'),false);
  assert.equal(await client.receive(await wrap(rumor(peer.pubkey,identity.pubkey,'retained'),peer,identity.pubkey,keys[1]),'history'),true);
  now+=6000;await client.rotateEncryptionKey();assert.deepEqual(client.encryptionKeys().legacy.map(k=>k.publicKey),[keys[3]]);
 }finally{await client.close();}
});

test('automatic rotation is due after restart, retries failed announcements and stops scheduling on stop',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chirli-scheduler-')),relay=new Relay(),identity=localNip17Identity(),storageKey=generateSecretKey();
 const config={...options(identity,relay,'nip4e'),database:join(dir,'state.db'),storageKey,keyRotation:{intervalMs:1000}};let client=new Client(config);
 const errors:unknown[]=[];
 try{
  await client.announce();const initial=client.encryptionKeys().currentPublicKey;client.onError(e=>{errors.push(e);});await client.start();
  relay.fail=true;await until(()=>errors.length>0);assert.ok(client.encryptionKeys().pending);relay.fail=false;
  await until(()=>client.encryptionKeys().currentPublicKey!==initial);await client.stop();
  const before=relay.attempts.length;await new Promise(r=>setTimeout(r,1100));assert.equal(relay.attempts.length,before);
  const old=client.encryptionKeys().currentPublicKey;await client.close();client=new Client({...config,transport:relay.transport()});await client.start();assert.notEqual(client.encryptionKeys().currentPublicKey,old);
 }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});

test('mode migration is explicit and preserves separate decryption keys, history scopes and foreign declarations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chirli-migrate-')),relay=new Relay(),key=generateSecretKey(),account=localNip17Identity(),peer=localIdentity();
 const base={...options(account,relay),database:join(dir,'state.db'),storageKey:key};let client=new Client(base);
 try{
  await client.announce();await client.close();client=new Client({...base,mode:'nip4e',transport:relay.transport()});
  await assert.rejects(client.announce(),Nip4eCompatibilityError);await client.announce({replaceEncryptionKey:account.pubkey});const split=client.encryptionKeys().currentPublicKey;
  assert.notEqual(split,account.pubkey);client.store.saveSession(peer.pubkey,{mode:'split'});await client.close();
  client=new Client({...base,transport:relay.transport()});await assert.rejects(client.start(),Nip4eCompatibilityError);await client.announce({replaceEncryptionKey:split});await client.start();
  assert.ok(client.encryptionKeys().decryptionPublicKeys.includes(split));assert.equal(client.store.session(peer.pubkey),undefined);
  assert.equal(await client.receive(await wrap(rumor(peer.pubkey,account.pubkey,'late split recipient'),peer,account.pubkey,split),'history'),true);
  await client.close();client=new Client({...base,transport:relay.transport()});assert.ok(client.encryptionKeys().decryptionPublicKeys.includes(split));
 }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});

test('ACK followed by disk failure retains the exact staged operation and decrypts both keys until recovery',async()=>{
 const relay=new Relay(),identity=localNip17Identity(),client=new Client(options(identity,relay,'nip4e'));
 try{
  await client.announce();const before=client.encryptionKeys().currentPublicKey,save=client.store.saveKeyring.bind(client.store);let failing=true;
  client.store.saveKeyring=(account,state)=>{const value=state as {active?:{secret:string};pending?:unknown};if(failing&&!value.pending&&value.active&&getPublicKey(Buffer.from(value.active.secret,'hex'))!==before)throw new Error('commit disk failure');save(account,state);};
  await assert.rejects(client.rotateEncryptionKey(),/commit disk failure/);const pending=client.encryptionKeys().pending!;assert.ok(pending);
  assert.equal(client.encryptionKeys().currentPublicKey,before);assert.ok(client.encryptionKeys().decryptionPublicKeys.includes(pending.publicKey));
  failing=false;await client.rotateEncryptionKey();assert.equal(client.encryptionKeys().currentPublicKey,pending.publicKey);
  assert.ok(relay.attempts.filter(e=>e.kind===10044&&e.tags[0][1]===pending.publicKey).every(e=>e.id===pending.eventId));
 }finally{await client.close();}
});

test('restart with an evicted original bootstrap key does not roll back or reimport that expired key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chirli-bootstrap-')),relay=new Relay(),identity=localIdentity(),storageKey=generateSecretKey(),initial=getPublicKey(identity.encryptionKey);
 const config={...options(identity,relay,'nip4e'),database:join(dir,'state.db'),storageKey,keyRotation:{intervalMs:1000,retainLegacyKeys:1}};let client=new Client(config);
 try{
  await client.announce();await client.rotateEncryptionKey();await client.rotateEncryptionKey();const current=client.encryptionKeys().currentPublicKey;
  assert.ok(!client.encryptionKeys().decryptionPublicKeys.includes(initial));await client.close();client=new Client({...config,transport:relay.transport()});
  assert.equal(client.encryptionKeys().currentPublicKey,current);assert.ok(!client.encryptionKeys().decryptionPublicKeys.includes(initial));await client.start();
 }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});
