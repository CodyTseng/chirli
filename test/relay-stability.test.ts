import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Event} from 'nostr-tools';
import {Bot,nsecSigner,generateSecretKey,type Transport} from '../src/index.js';
import {PublicInbox} from '../src/public-inbox.js';
import {localNip17Identity} from '../src/protocol.js';
import {MemoryRelay} from '../examples/_support.js';
import {npubEncode} from 'nostr-tools/nip19';
const urls=['ws://stability-one.invalid','ws://stability-two.invalid'];
const canonical=(url:string)=>new URL(url).href;
const until=async(check:()=>boolean)=>{const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('Local fixture deadline');await new Promise(resolve=>setTimeout(resolve,2));}};
class ControlledRelays{
 network=new MemoryRelay();wire=this.network.transport();
 records:{url:string;attempt:number;closed:boolean;ready:boolean;receive:(event:Event,source:'live'|'history')=>void;close():void;drop():void}[]=[];
 readiness:(url:string,attempt:number)=>Promise<void>|undefined=()=>undefined;
 transport:Transport={...this.wire,subscribe:(relays,filter,receive,disconnect)=>{
  const sub=this.wire.subscribe(relays,filter,receive,disconnect);
  if(!filter.kinds?.some(kind=>[1,1111].includes(kind)))return sub;
  const url=canonical(relays[0]),attempt=this.records.filter(record=>record.url===url).length+1;
  const record={url,attempt,closed:false,ready:false,receive,close(){if(!record.closed){record.closed=true;sub.close();}},drop(){if(record.closed)return;record.close();disconnect?.(new Error('simulated relay disconnect'));}};
  this.records.push(record);const extra=this.readiness(url,attempt),ready=extra?extra.then(()=>sub.ready):sub.ready;
  void ready.then(()=>{if(!record.closed)record.ready=true;},()=>{});
  return{ready,close:record.close};
 }};
 latest(url:string){return this.records.filter(record=>record.url===canonical(url)&&!record.closed).at(-1)!;}
 attempts(url:string){return this.records.filter(record=>record.url===canonical(url)).length;}
 close(){this.wire.close();}
}
const makeEvent=(author:ReturnType<typeof localNip17Identity>,pubkey:string,time:number)=>author.sign({kind:1,created_at:time,tags:[],content:`/ping@${npubEncode(pubkey)}`});
const definition={id:'ping',command:'ping',title:'Ping',description:'Ping',scopes:['kind:1']};

test('explicit same-kind sync reopens a disconnected formerly-ready public inbox without background retry',async()=>{
 const network=new ControlledRelays(),author=localNip17Identity();let calls=0,failures=0;
 const bot=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',relays:[urls[0]],publicInbox:{relays:[urls[0]]},transport:network.transport,reconnect:false});bot.command({command:'ping',scopes:['kind:1']},ctx=>{calls++;if(ctx.input.event.created_at===2){failures++;throw new Error('business failure');}});
 try{await bot.start();await network.wire.publish(urls,await makeEvent(author,bot.pubkey,1));await bot.idle();assert.equal(calls,1);
  await network.wire.publish(urls,await makeEvent(author,bot.pubkey,2));await bot.idle();assert.equal(failures,1);
  const old=network.latest(urls[0]);old.drop();await new Promise(resolve=>setImmediate(resolve));assert.equal(network.attempts(urls[0]),1);
  const late=await makeEvent(author,bot.pubkey,3);old.receive(late,'live');await bot.idle();assert.equal(calls,2);
  await bot.syncCommands();assert.equal(network.attempts(urls[0]),2);await bot.idle();assert.equal(calls,2,'relay history and failed business work are not replayed by reconnect');assert.equal(failures,1);await network.wire.publish(urls,late);await bot.idle();assert.equal(calls,3);
  await bot.stop();await bot.syncCommands();assert.equal(network.attempts(urls[0]),2,'sync after stop must not revive subscriptions');
 }finally{await bot.close();network.close();}
});

test('one failed replica does not recycle another healthy public replica; all-down explicit retry restores demand',async()=>{
 const network=new ControlledRelays(),author=localNip17Identity();let calls=0;
 const bot=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',relays:urls,publicInbox:{relays:urls},transport:network.transport,reconnect:false});bot.command({command:'ping',scopes:['kind:1']},()=>{calls++;});
 try{await bot.start();await until(()=>network.records.filter(record=>record.ready).length===2);const healthy=network.latest(urls[1]);network.latest(urls[0]).drop();await bot.syncCommands();assert.equal(healthy.closed,false);assert.deepEqual(urls.map(url=>network.attempts(url)),[1,1]);
  await network.wire.publish(urls,await makeEvent(author,bot.pubkey,1));await bot.idle();assert.equal(calls,1);healthy.drop();await bot.syncCommands();assert.deepEqual(urls.map(url=>network.attempts(url)),[2,2]);await network.wire.publish(urls,await makeEvent(author,bot.pubkey,2));await bot.idle();assert.equal(calls,2);
 }finally{await bot.close();network.close();}
});

test('first automatic recovery initializes local pending/failed once across replicas, while later reconnects do not retry business failures',async()=>{
 const network=new ControlledRelays(),identity=localNip17Identity(),author=localNip17Identity(),pending=await makeEvent(author,identity.pubkey,1),failed=await makeEvent(author,identity.pubkey,2),history=await makeEvent(author,identity.pubkey,3),liveFailure=await makeEvent(author,identity.pubkey,4),offlineHistory=await makeEvent(author,identity.pubkey,5);
 let saved:any={version:1,records:{[pending.id]:{event:pending,relay:canonical(urls[0]),state:'pending'},[failed.id]:{event:failed,relay:canonical(urls[0]),state:'failed'}},outbox:[]};
 const store={metadata:()=>structuredClone(saved),saveMetadata:(_key:string,value:unknown)=>{saved=structuredClone(value);}};
 let releaseSecond!:()=>void;const secondGate=new Promise<void>(resolve=>{releaseSecond=resolve;});network.readiness=(url,attempt)=>attempt===1?Promise.reject(new Error('initial EOSE failed')):url===canonical(urls[1])&&attempt===2?secondGate:undefined;
 const calls=new Map<string,number>();await network.wire.publish(urls,history);
 const inbox=new PublicInbox(identity,store as never,network.transport,{relays:urls},urls,{initialDelayMs:1,maxDelayMs:1,jitter:0},()=>[definition],()=>true,async input=>{calls.set(input.event.id,(calls.get(input.event.id)??0)+1);if([failed.id,liveFailure.id].includes(input.event.id))throw new Error('application failure');},()=>{});
 try{await assert.rejects(inbox.start([1]));await until(()=>calls.get(pending.id)===1&&calls.get(failed.id)===1);await inbox.idle();assert.equal(calls.has(history.id),false);assert.equal(saved.records[pending.id].state,'done');assert.equal(saved.records[failed.id].state,'failed');
  releaseSecond();await until(()=>network.latest(urls[1])?.ready===true);await new Promise(resolve=>setImmediate(resolve));await inbox.idle();assert.equal(calls.get(failed.id),1,'a second recovered replica must not repeat failed initialization work');
  await network.wire.publish(urls,liveFailure);await inbox.idle();assert.equal(calls.get(liveFailure.id),1);network.latest(urls[0]).drop();network.latest(urls[1]).drop();await network.wire.publish(urls,offlineHistory);await until(()=>urls.every(url=>network.attempts(url)>=3&&network.latest(url)?.ready));await new Promise(resolve=>setImmediate(resolve));await inbox.idle();assert.equal(calls.get(failed.id),1);assert.equal(calls.get(liveFailure.id),1);assert.equal(calls.has(offlineHistory.id),false);
  inbox.retry(new Set([failed.id]));await inbox.idle();assert.equal(calls.get(failed.id),2,'explicit retry remains available');
 }finally{releaseSecond();inbox.stop();await inbox.idle();network.close();}
});

test('stop fences delayed first recovery before local unfinished initialization',async()=>{
 const network=new ControlledRelays(),identity=localNip17Identity(),author=localNip17Identity(),pending=await makeEvent(author,identity.pubkey,1);let calls=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});network.readiness=(_url,attempt)=>attempt===1?Promise.reject(new Error('initial failure')):gate;
 let saved:any={version:1,records:{[pending.id]:{event:pending,relay:canonical(urls[0]),state:'pending'}},outbox:[]};const store={metadata:()=>structuredClone(saved),saveMetadata:(_key:string,value:unknown)=>{saved=structuredClone(value);}};
 const inbox=new PublicInbox(identity,store as never,network.transport,{relays:[urls[0]]},urls,{initialDelayMs:1,maxDelayMs:1,jitter:0},()=>[definition],()=>true,async()=>{calls++;},()=>{});
 try{await assert.rejects(inbox.start([1]));await until(()=>network.attempts(urls[0])===2);inbox.stop();release();await new Promise(resolve=>setImmediate(resolve));await inbox.idle();assert.equal(calls,0);assert.equal(saved.records[pending.id].state,'pending');assert.equal(network.latest(urls[0]),undefined);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(network.attempts(urls[0]),2);
 }finally{release();inbox.stop();await inbox.idle();network.close();}
});
