import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Bot,nsecSigner,generateSecretKey,type Transport,type CommandSyncResult} from '../src/index.js';
import {Client} from '../src/client.js';
import {PublicInbox} from '../src/public-inbox.js';
import {localNip17Identity} from '../src/protocol.js';
import {MemoryRelay} from '../examples/_support.js';
import {npubEncode} from 'nostr-tools/nip19';
import {commentReply} from '../src/public-thread.js';
const urls=['ws://retry-memory.invalid'];
const wireDefinition=(name:string)=>({id:name,command:name,title:name,description:name,scopes:['kind:1','kind:1111']});
function claimStore(){
 const ids=new Set<string>();
 return {metadata:()=>undefined,saveMetadata(){},claimInput(id:string){if(ids.has(id))return false;ids.add(id);return true;}} as never;
}

test('same-kind command sync really subscribes again after initial EOSE rejection with reconnect disabled',async()=>{
 const network=new MemoryRelay(),wire=network.transport();let attempts=0,calls=0;
 const transport:Transport={...wire,subscribe:(relays,filter,receive,disconnect)=>{if(filter.kinds?.includes(1)&&++attempts===1)return{ready:Promise.reject(new Error('local EOSE failure')),close(){}};return wire.subscribe(relays,filter,receive,disconnect);}};
 const bot=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',relays:urls,publicInbox:{relays:urls},transport,reconnect:false});
 try{await bot.start();bot.command({command:'ping',scopes:['kind:1']},()=>{calls++;});await assert.rejects(bot.syncCommands(),/local EOSE failure/);assert.equal(attempts,1);
  assert.deepEqual(await bot.syncCommands(),{added:[],updated:[],removed:[]});assert.equal(attempts,2);
  const author=localNip17Identity(),event=await author.sign({kind:1,created_at:1,tags:[],content:`/ping@${npubEncode(bot.pubkey)}`});await wire.publish(urls,event);await bot.idle();assert.equal(calls,1);
 }finally{await bot.close();wire.close();}
});

test('same-kind callers wait on shared readiness, and a stale rejected owner cannot close its replacement',async()=>{
 const identity=localNip17Identity(),author=localNip17Identity(),network=new MemoryRelay(),wire=network.transport();let attempts=0,disconnectOld:((error:Error)=>void)|undefined,closedNew=0,calls=0;
 const transport:Transport={...wire,subscribe:(relays,filter,receive,disconnect)=>{
  if(++attempts===1){disconnectOld=disconnect;return{ready:new Promise(()=>{}),close(){}};}
  const sub=wire.subscribe(relays,filter,receive,disconnect);return{ready:sub.ready,close(){closedNew++;sub.close();}};
 }};
 const inbox=new PublicInbox(identity,claimStore(),transport,{relays:urls},urls,false,()=>[wireDefinition('ping')],async()=>{calls++;},()=>{});
 try{const first=inbox.start([1]);assert.equal(inbox.start([1]),first);const rejected=assert.rejects(first,/old failure/);disconnectOld!(new Error('old failure'));const next=inbox.start([1111]);await rejected;await next;assert.equal(closedNew,0);assert.equal(attempts,2);
  const root=await author.sign({kind:1,created_at:1,tags:[],content:'root'}),event=await author.sign(commentReply(root,{id:root.id,kind:'1',author:root.pubkey},`/ping@${npubEncode(identity.pubkey)}`));await wire.publish(urls,event);await inbox.idle();assert.equal(calls,1);
 }finally{inbox.stop();await inbox.idle();wire.close();}
});

test('initial failure retains configured automatic reconnect, and recovered readiness does not resubscribe again',async()=>{
 const identity=localNip17Identity(),author=localNip17Identity(),network=new MemoryRelay(),wire=network.transport();let attempts=0,calls=0;
 const transport:Transport={...wire,subscribe:(relays,filter,receive,disconnect)=>{if(++attempts===1)return{ready:Promise.reject(new Error('initial failure')),close(){}};return wire.subscribe(relays,filter,receive,disconnect);}};
 const inbox=new PublicInbox(identity,claimStore(),transport,{relays:urls},urls,{initialDelayMs:1,maxDelayMs:1,jitter:0},()=>[wireDefinition('ping')],async()=>{calls++;},()=>{});
 try{await assert.rejects(inbox.start([1]),/initial failure/);const end=Date.now()+1000;while(!Reflect.get(inbox,'initialReady')){if(Date.now()>end)throw new Error('Local reconnect deadline');await new Promise(resolve=>setTimeout(resolve,1));}assert.equal(attempts,2);await inbox.start([1]);assert.equal(attempts,2);
  const event=await author.sign({kind:1,created_at:1,tags:[],content:`/ping@${npubEncode(identity.pubkey)}`});await wire.publish(urls,event);await inbox.idle();assert.equal(calls,1);
 }finally{inbox.stop();await inbox.idle();wire.close();}
});

test('coalesced result nets completed per-round changes without duplicate or crossed categories',async()=>{
 const empty=():CommandSyncResult=>({added:[],updated:[],removed:[]});
 const cases:{rounds:CommandSyncResult[];expected:CommandSyncResult}[]=[
  {rounds:[{...empty(),added:['a','b']},{...empty(),updated:['a','a'],added:['b','c']}],expected:{added:['a','b','c'],updated:[],removed:[]}},
  {rounds:[{...empty(),added:['a']},{...empty(),removed:['a']}],expected:empty()},
  {rounds:[{...empty(),updated:['a']},{...empty(),removed:['a','a']}],expected:{added:[],updated:[],removed:['a']}},
  {rounds:[{...empty(),removed:['a']},{...empty(),added:['a']}],expected:{added:[],updated:['a'],removed:[]}},
  {rounds:[{...empty(),updated:['a']},{...empty(),updated:['a']}],expected:{added:[],updated:['a'],removed:[]}},
 ];
 for(const {rounds,expected}of cases){
  const wire:Transport={query:async()=>[],publish:async()=>{},subscribe:()=>({ready:Promise.resolve(),close(){}}),close(){}};
  const client=await Client.create({signer:nsecSigner(generateSecretKey()),database:':memory:',relays:urls,transport:wire});let index=0;
  // Isolate the result contract; real signed catalog/EOSE behavior is covered by command-sync-race.
  Reflect.get(client,'commands').sync=async()=>{const round=rounds[index++];if(index<rounds.length)client.registerCommandDefinition({...wireDefinition(`round-${index}`),scopes:['kind:14']});return round;};
  try{assert.deepEqual(await client.syncCommands(),expected);assert.equal(index,rounds.length);}finally{await client.close();}
 }
});
