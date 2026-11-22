import { localNip17Identity, localIdentity } from '../src/protocol.js';
import { Client } from './client.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {matchFilter,type Event,type Filter} from 'nostr-tools';
import { WebSocketTransport, type RelayTiming, type Transport } from '../src/index.js';
import {configuration} from '../examples/live/config.js';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
for(const mode of ['nip17','nip4e'] as const)test(`${mode}: independent reply discovery starts concurrently, with fresh pre-publish guard retained`,async()=>{
 const identity=mode==='nip17'?localNip17Identity():localIdentity(),peer=localNip17Identity();let events:Event[]=[];
 const queries:Filter[]=[],sequence:string[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const transport:Transport={query:async(_relays,filter)=>{queries.push(filter);const n=queries.length;sequence.push(`start${n}`);if(n<=3){if(n===3)release();await gate;}sequence.push(`end${n}`);return events.filter(e=>matchFilter(filter,e));},publish:async()=>{},subscribe:()=>({ready:Promise.resolve(),close(){}}),close(){}};
 const client=new Client({identity,mode,relays:['ws://local.invalid'],database:':memory:',transport});
 try{
  events=await Promise.all([identity.sign({kind:10044,created_at:10,tags:[['n',client.encryptionKeys().currentPublicKey]],content:''}),...[identity,peer].map(owner=>owner.sign({kind:10050,created_at:10,tags:[['relay','ws://local.invalid']],content:''}))]);
  const result=await Promise.race([client.send(peer.pubkey,'test reply'),pause(1000).then(()=>{throw new Error('Discovery remained serial');})]);assert.equal(result.status,'relay-accepted');
  assert.equal(queries.length,4,'three concurrent discovery reads plus a fresh flush guard');assert.equal(sequence.slice(0,3).every(item=>item.startsWith('start')),true);assert.deepEqual(queries.at(-1)?.kinds,[10044]);
 }finally{release();await client.close();}
});
test('parallel discovery does not apply peer key evidence or queue messages if own identity conflicts',async()=>{
 const identity=localNip17Identity(),peer=localIdentity(),foreign=localNip17Identity();
 const events=await Promise.all([identity.sign({kind:10044,created_at:10,tags:[['n',foreign.pubkey]],content:''}),peer.sign({kind:10044,created_at:10,tags:[['n',peer.pubkey]],content:''}),...[identity,peer].map(owner=>owner.sign({kind:10050,created_at:10,tags:[['relay','ws://local.invalid']],content:''}))]);
 const transport:Transport={query:async(_relays,filter)=>events.filter(e=>matchFilter(filter,e)),publish:async()=>assert.fail('must not publish'),subscribe:()=>({ready:Promise.resolve(),close(){}}),close(){}};
 const client=new Client({identity,relays:['ws://local.invalid'],database:':memory:',transport});
 try{await assert.rejects(client.send(peer.pubkey,'blocked'));assert.equal(client.store.evidence(peer.pubkey),undefined);assert.equal(client.store.outbox().length,0);assert.equal(client.history(peer.pubkey).messages.length,0);}finally{await client.close();}
});
async function server(hang:boolean){
 const ws=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise<void>(r=>ws.once('listening',r));
 ws.on('connection',socket=>socket.on('message',raw=>{const m=JSON.parse(String(raw));if(m[0]==='REQ'&&!hang)socket.send(JSON.stringify(['EOSE',m[1]]));if(m[0]==='EVENT')socket.send(JSON.stringify(['OK',m[1].id,true,'stored']));}));
 return{url:`ws://127.0.0.1:${(ws.address() as {port:number}).port}`,async close(){for(const socket of ws.clients)socket.terminate();await new Promise<void>(r=>ws.close(()=>r()));}};
}
test('per-relay timings identify a slow metadata replica without author/content/URL secrets',async()=>{
 const fast=await server(false),slow=await server(true),metrics:RelayTiming[]=[],wire=new WebSocketTransport(150,undefined,metric=>{metrics.push(metric);}),identity=localNip17Identity();
 try{
  await wire.query([fast.url,`${slow.url}/private-path?token=SECRET`],{authors:[identity.pubkey],kinds:[10044,10050]});
  assert.equal(metrics.length,2);const delayed=metrics.find(m=>m.relay===slow.url)!;assert.equal(delayed.outcome,'error');assert.equal(delayed.code,'RELAY_EOSE_TIMEOUT');assert.ok(delayed.durationMs>=100);assert.equal(metrics.find(m=>m.relay===fast.url)?.outcome,'ok');
  const event=await identity.sign({kind:10050,created_at:10,tags:[],content:'PRIVATE-TEXT'});await wire.publish([fast.url],event);assert.equal(metrics.at(-1)?.operation,'publish');assert.equal(metrics.at(-1)?.outcome,'ok');
  const output=JSON.stringify(metrics);for(const text of ['SECRET','private-path',identity.pubkey,'PRIVATE-TEXT',event.id])assert.ok(!output.includes(text));
 }finally{wire.close();await fast.close();await slow.close();}
});
test('timing observers cannot change query or publication outcomes',async()=>{
 const relay=await server(false),wire=new WebSocketTransport(500,undefined,async()=>{throw new Error('observer failure');}),identity=localNip17Identity();
 try{assert.deepEqual(await wire.query([relay.url],{kinds:[10050]}),[]);await wire.publish([relay.url],await identity.sign({kind:10050,created_at:10,tags:[],content:''}));await pause(0);}finally{wire.close();await relay.close();}
});
test('live timing and timeout configuration is optional and bounded',()=>{
 assert.equal(configuration({}).timing,false);assert.equal(configuration({}).relayTimeoutMs,undefined);assert.equal(configuration({CHIRLI_TIMING:'1',CHIRLI_RELAY_TIMEOUT_MS:'1500'}).timing,true);
 for(const value of ['0','99','120001','NaN'])assert.throws(()=>configuration({CHIRLI_RELAY_TIMEOUT_MS:value}));
});

test('live signer timings omit crypto inputs and raw errors and preserve operations/close',async()=>{
 const {timedSigner}=await import('../examples/live/timing.js');const lines:string[]=[];let closed=false;const privateText='SECRET-CRYPTO-ARGUMENT';
 const signer={getPublicKey:async()=>privateText,signEvent:async()=>{throw new Error(privateText);},nip44Encrypt:async()=>privateText,nip44Decrypt:async()=>privateText,close:async()=>{closed=true;}};
 const wrapped=timedSigner(signer,line=>{lines.push(line);});assert.equal(await wrapped.getPublicKey(),privateText);await assert.rejects(wrapped.signEvent({kind:14,created_at:10,tags:[],content:privateText}));assert.equal(await wrapped.nip44Encrypt(privateText,privateText),privateText);assert.equal(await wrapped.nip44Decrypt(privateText,privateText),privateText);await wrapped.close();assert.ok(closed);
 assert.equal(lines.length,5);assert.match(lines[1],/signEvent.*outcome=error/);assert.ok(!lines.join('\n').includes(privateText));assert.equal(await timedSigner(signer,()=>{throw new Error('observer failed');}).getPublicKey(),privateText);
});
