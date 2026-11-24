import {z} from 'zod';
import { localIdentity, localNip17Identity, type LocalIdentity as Identity } from '../src/protocol.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finalizeEvent, nip44, type Event } from 'nostr-tools';
import { generateSecretKey, getPublicKey, WebSocketTransport, type ProtocolMode, type Transport } from '../src/index.js';
import { BotHandlers as Bot } from '../src/bot-handlers.js';
import { rumor } from '../src/protocol.js';
import { testRelay } from './relay.js';
async function until(check: () => boolean | Promise<boolean>) { for (let i=0;i<200;i++) { if(await check())return; await new Promise(resolve=>setTimeout(resolve,10)); } assert.fail('condition timeout'); }
async function envelope(sender: Identity, receiver: Identity, text: string, time: number, mode: ProtocolMode = 'nip4e') {
  const encrypt = (value: unknown, key: Uint8Array, peer: string) => nip44.v2.encrypt(JSON.stringify(value), nip44.v2.utils.getConversationKey(key,peer));
  const r = rumor(sender.pubkey,receiver.pubkey,text,time*1000);
  const seal = await sender.sign({kind:13,created_at:time,tags:mode==='nip17'?[]:[['n',getPublicKey(sender.encryptionKey)]],content:encrypt(r,sender.encryptionKey,getPublicKey(receiver.encryptionKey))});
  const secret=generateSecretKey();
  return finalizeEvent({kind:1059,created_at:time,tags:[['p',receiver.pubkey]],content:encrypt(seal,secret,getPublicKey(receiver.encryptionKey))},secret);
}
for(const mode of ['nip4e','nip17'] as const) {
  test(`${mode}: automatic reconnect pages missed history without replaying commands`,async()=>{
    const relay=await testRelay(), identity=mode==='nip17'?localNip17Identity:localIdentity, sender=identity(), receiver=identity();
    const wire=new WebSocketTransport(), errors:unknown[]=[];
    const client=new Client({mode,identity:receiver,relays:[relay.url],database:':memory:',storageKey:generateSecretKey(),historyLimit:1,reconnect:{initialDelayMs:30,maxDelayMs:60,jitter:0},recovery:{pageSize:2,maxPages:20}});
    const bot=new Bot(client);let commands=0;bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})},()=>{commands++;});client.onError(error=>{errors.push(error);});
    const now=Math.floor(Date.now()/1000);
    try {
      await bot.start();
      await wire.publish([relay.url],await envelope(sender,receiver,'/ping',now,mode));await until(()=>commands===1);
      relay.pauseReads(true);relay.disconnect();await until(()=>errors.length>0);
      const missed:Event[]=[];
      for(let i=0;i<6;i++){const event=await envelope(sender,receiver,`/ping missed-${i}`,now-10-i,mode);missed.push(event);await wire.publish([relay.url],event);}
      relay.pauseReads(false);
      await until(()=>relay.connections>=3);
      await until(async()=>{const [sync]=await client.syncHistory();if(sync.status==='aborted')return false;assert.equal(sync.status,'window-complete');assert.ok(sync.pages>1);return true;});await client.idle();
      assert.equal(commands,1);for(const event of missed)assert.equal(await client.receive(event,'live'),false,'recovered input IDs are claimed');
      await wire.publish([relay.url],await envelope(sender,receiver,'/ping',now+1,mode));await until(()=>commands===2);await client.idle();
      assert.deepEqual(client.history(sender.pubkey).messages.map(message=>message.text),['/ping','/ping']);
      await bot.stop();const attempts=relay.connections;relay.disconnect();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(relay.connections,attempts,'stop cancels reconnect demand');
    }finally{await bot.client.close(); bot.dispose();wire.close();await relay.close();}
  });
}

test('page and timestamp-bucket bounds leave history checkpoints unchanged',async()=>{
  for(const boundary of [false,true]){
    const relay=await testRelay(), sender=localIdentity(),receiver=localIdentity(),wire=new WebSocketTransport(),now=Math.floor(Date.now()/1000);
    const client=new Client({mode:'nip4e',identity:receiver,relays:[relay.url],database:':memory:',storageKey:generateSecretKey(),historyLimit:0,recovery:{pageSize:2,maxPages:boundary?10:1}});
    client.onError(()=>{});
    try{
      for(let i=0;i<3;i++)await wire.publish([relay.url],await envelope(sender,receiver,`historical-${i}`,boundary?now-10:now-10-i));
      await client.start();const [result]=await client.syncHistory();assert.equal(result.status,'incomplete');assert.equal(result.reason,boundary?'boundary-overflow':'page-limit');assert.equal(client.store.checkpoint(relay.url),undefined);
    }finally{await client.close();wire.close();await relay.close();}
  }
});

test('persisted recovery checkpoint covers an older offline gap and advances only after a drained scan',async()=>{
  const relay=await testRelay(),dir=await mkdtemp(join(tmpdir(),'chirli-recovery-')),receiver=localIdentity(),sender=localIdentity(),key=generateSecretKey(),now=Math.floor(Date.now()/1000),wire=new WebSocketTransport();
  const options={mode:'nip4e' as const,identity:receiver,relays:[relay.url],database:join(dir,'inbox.sqlite'),storageKey:key,historyLimit:0};let client=new Client(options);
  try{
    client.store.saveCheckpoint(relay.url,now-5*86400);await client.close();
    const older=await envelope(sender,receiver,'older gap',now-4*86400);await wire.publish([relay.url],older);
    client=new Client(options);let calls=0;client.handle(()=>{calls++;});await client.start();await client.idle();
    assert.deepEqual(client.history(sender.pubkey).messages,[]);assert.equal(calls,0);assert.ok(client.store.checkpoint(relay.url)!>=now);
    await client.close();client=new Client(options);assert.ok(client.store.checkpoint(relay.url)!>=now);await client.start();assert.equal(await client.receive(older,'live'),false);
  }finally{await client.close();wire.close();await relay.close();await rm(dir,{recursive:true,force:true});}
});

test('stop cancels in-flight recovery reads and fences their late callbacks',async()=>{
  let queryStarted=false, late:((event:Event,source:'history'|'live')=>void)|undefined,closed=0;
  const transport:Transport={query:async()=>[],publish:async()=>{},close(){},subscribe:(_relays,filter,callback)=>{
    if(filter.since!==undefined){queryStarted=true;late=callback;return{ready:new Promise<void>(()=>{}),close(){closed++;}};}
    return{ready:Promise.resolve(),close(){closed++;}};
  }};
  const receiver=localIdentity(),client=new Client({mode:'nip4e',identity:receiver,relays:['ws://memory.invalid'],transport,database:':memory:',storageKey:generateSecretKey()});
  const starting=client.start();await until(()=>queryStarted);await client.stop();await starting;assert.ok(closed>=2);await client.close();
  assert.doesNotThrow(()=>late?.(finalizeEvent({kind:1,created_at:10,tags:[],content:'late'},generateSecretKey()),'history'));
});

test('reconnect retries pending outbox with the persisted rumor and giftwrap identities',async()=>{
  const relay=await testRelay(),a=localIdentity(),b=localIdentity(),errors:unknown[]=[];
  const client=new Client({mode:'nip4e',identity:a,relays:[relay.url],database:':memory:',storageKey:generateSecretKey(),reconnect:{initialDelayMs:20,maxDelayMs:40,jitter:0}});
  const peer=new Client({mode:'nip4e',identity:b,relays:[relay.url],database:':memory:',storageKey:generateSecretKey()});client.onError(error=>{errors.push(error);});
  try{
    await client.announce();await peer.announce();await client.start();relay.reject(true);
    const sent=await client.send(b.pubkey,'pending before reconnect');assert.equal(sent.status,'pending');
    const ids=client.store.outbox()[0].events.map(item=>item.event.id);const before=errors.length;
    relay.reject(false);relay.pauseReads(true);relay.disconnect();await until(()=>errors.length>before);relay.pauseReads(false);
    await until(()=>client.store.outbox().length===0);await client.idle();
    assert.ok(ids.every(id=>relay.events.has(id)));assert.equal(client.history(b.pubkey).messages.filter(message=>message.id===sent.id).length,1);
  }finally{await client.close();await peer.close();await relay.close();}
});
