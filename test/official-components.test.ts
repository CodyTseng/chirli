import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Bot,allowlist,requestTiming,nsecSigner,generateSecretKey,type InboundPolicy,type RequestTiming,type Transport} from '../src/index.js';
import {Client} from './client.js';
import {localNip17Identity,rumor,wrap,standardEnvelope} from '../src/protocol.js';
import {MemoryRelay} from '../examples/_support.js';
const urls=['ws://memory.invalid'];
const transport:Transport={query:async()=>[],publish:async()=>{},subscribe:()=>({ready:Promise.resolve(),close(){}}),close(){}};

test('official allowlist snapshots and validates identity keys, including empty deny-all',()=>{
 const identity=localNip17Identity(),other=localNip17Identity(),keys=[identity.pubkey],policy=allowlist(keys);keys.splice(0,1,other.pubkey);
 assert.equal(policy(identity.pubkey),true);assert.equal(policy(other.pubkey),false);assert.equal(allowlist([])(identity.pubkey),false);
 for(const values of [['bad'],[identity.pubkey.toUpperCase()],['npub1bad'],new Array(1),null,'not-an-array'])assert.throws(()=>allowlist(values as never),/lowercase hex/);
});
test('legacy allowlist and optional inbound policy compose restrictively; policy sees only authenticated sender and own copies bypass it',async()=>{
 const identity=localNip17Identity(),peer=localNip17Identity();let observed:unknown[]=[];
 const options={identity,relays:urls,transport,database:':memory:'};
 const blocked=new Client({...options,allowlist:[],inboundPolicy:sender=>{observed.push(sender);return true;}});
 try{assert.equal(await blocked.receive(await wrap(rumor(peer.pubkey,identity.pubkey,'blocked'),peer,identity.pubkey,identity.pubkey,standardEnvelope),'live'),false);assert.deepEqual(observed,[]);assert.equal(blocked.history(peer.pubkey).messages.length,0);}finally{await blocked.close();}
 const client=new Client({...options,allowlist:[peer.pubkey],inboundPolicy:sender=>{observed.push(sender);return false;}});
 try{
  assert.equal(await client.receive(await wrap(rumor(peer.pubkey,identity.pubkey,'denied by second gate'),peer,identity.pubkey,identity.pubkey,standardEnvelope),'history'),false);assert.deepEqual(observed,[peer.pubkey]);assert.equal(typeof observed[0],'string');assert.equal(client.history(peer.pubkey).messages.length,0);
  observed=[];const self=await wrap(rumor(identity.pubkey,peer.pubkey,'self copy'),identity,identity.pubkey,identity.pubkey,standardEnvelope);assert.equal(await client.receive(self,'history'),true);assert.deepEqual(observed,[]);assert.equal(client.history(peer.pubkey).messages[0].direction,'outgoing');
 }finally{await client.close();}
});
test('inbound policy errors, Promise and truthy results never authorize or persist a message',async()=>{
 const identity=localNip17Identity(),peer=localNip17Identity(),event=await wrap(rumor(peer.pubkey,identity.pubkey,'private'),peer,identity.pubkey,identity.pubkey,standardEnvelope);
 for(const create of [()=>1,()=> 'yes',()=>undefined,()=>Promise.resolve(true),()=>Promise.reject(new Error('private policy failure'))]){
  const result=create();
  // Install rejection handling before constructing the deliberately invalid JavaScript policy.
  if(result instanceof Promise)void result.catch(()=>{});
  const client=new Client({identity,relays:urls,transport,database:':memory:',inboundPolicy:(()=>result) as unknown as InboundPolicy});
  try{await assert.rejects(client.receive(event,'live'),/boolean synchronously/);assert.equal(client.history(peer.pubkey).messages.length,0);assert.equal(client.store.evidence(peer.pubkey),undefined);}finally{await client.close();}
 }
 const original=new Error('original policy failure'),client=new Client({identity,relays:urls,transport,database:':memory:',inboundPolicy:()=>{throw original;}});
 try{await assert.rejects(client.receive(event,'live'),error=>error===original);assert.equal(client.history(peer.pubkey).messages.length,0);}finally{await client.close();}
});
test('requestTiming reports exact processing-chain duration and no context or error fields',async ctx=>{
 let now=10;ctx.mock.method(performance,'now',()=>now);const metrics:Readonly<RequestTiming>[]=[];
 const middleware=requestTiming({onTiming:metric=>{metrics.push(metric);}});
 const context=new Proxy({}, {get(){assert.fail('Timing middleware must never inspect context');}});
 await middleware(context,async()=>{now+=25;});assert.deepEqual(metrics[0],{durationMs:25,outcome:'success'});assert.ok(Object.isFrozen(metrics[0]));
 const original=new Error('PRIVATE RAW ERROR');await assert.rejects(middleware(context,async()=>{now+=12;throw original;}),error=>error===original);
 assert.deepEqual(metrics[1],{durationMs:12,outcome:'failure'});assert.deepEqual(Object.keys(metrics[1]),['durationMs','outcome']);assert.ok(!JSON.stringify(metrics).includes('PRIVATE'));
});
test('timing observers cannot delay success, swallow original errors or cause retries', {timeout:1000},async()=>{
 const original=new Error('original');
 for(const observer of [()=>{throw new Error('observer');},async()=>{throw new Error('observer');},()=>new Promise<void>(()=>{})]){
  const middleware=requestTiming({onTiming:observer});await middleware(undefined,async()=>{});await assert.rejects(middleware(undefined,async()=>{throw original;}),error=>error===original);
 }
 assert.throws(()=>requestTiming(undefined as never),/onTiming/);
});
test('optional components work with public Bot.use and automatic command declarations, retaining handler failure state',async()=>{
 const network=new MemoryRelay(),peerSigner=nsecSigner(generateSecretKey()),peerIdentity=await peerSigner.getPublicKey(),metrics:Readonly<RequestTiming>[]=[],errors:unknown[]=[];
 const bot=new Bot({signer:nsecSigner(generateSecretKey()),transport:network.transport(),relays:urls,database:':memory:',inboundPolicy:allowlist([peerIdentity])});
 const peer=new Bot({signer:peerSigner,transport:network.transport(),relays:urls,database:':memory:'});let reply='';const original=new Error('PRIVATE HANDLER ERROR');
 bot.use(requestTiming({onTiming:metric=>{metrics.push(metric);if(metric.outcome==='failure')throw new Error('observer failure');}}));
 bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},async ctx=>{await ctx.reply('pong');});bot.command({command:"fail",title:"fail",description:"Run /fail in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{throw original;});bot.catch(error=>{errors.push(error);});peer.handle(ctx=>{reply=ctx.message.text;});
 try{
  await bot.start();await peer.start();const success=await peer.send(bot.pubkey,'/ping');await bot.idle();await peer.idle();assert.equal(reply,'pong');assert.equal(bot.getMessageState(success.id),'done');
  const failure=await peer.send(bot.pubkey,'/fail');await bot.idle();assert.equal(bot.getMessageState(failure.id),'failed');assert.deepEqual(errors,[original]);assert.deepEqual(metrics.map(metric=>metric.outcome),['success','failure']);
  const publicCommands=await peer.discoverCommands({authors:[bot.pubkey],relays:urls});assert.deepEqual(publicCommands.commands.map(command=>command.definition.command).sort(),['fail','ping']);
  for(const metric of metrics){assert.deepEqual(Object.keys(metric),['durationMs','outcome']);assert.ok(metric.durationMs>=0);}
 }finally{await bot.close();await peer.close();}
});

for(const mode of ['nip17','nip4e'] as const)test(`${mode}: optional policy does not widen ignored incoming reactions`,async()=>{
 const identity=localNip17Identity(),peer=localNip17Identity();
 const {reactionRumor,splitEnvelope}=await import('../src/protocol.js');
 let checks=0;const policy=allowlist([]);
 const client=new Client({identity,mode,relays:urls,transport,database:':memory:',inboundPolicy:sender=>{checks++;assert.equal(sender,peer.pubkey);return policy(sender);}});
 try{
  for(const policy of [standardEnvelope,splitEnvelope]){
   const target=policy===standardEnvelope?identity.pubkey:client.encryptionKeys().currentPublicKey;
   const event=await wrap(reactionRumor(peer.pubkey,identity.pubkey,'a'.repeat(64),'👍'),peer,identity.pubkey,target,policy);
   assert.equal(await client.receive(event,'history'),false);assert.equal(await client.receive(event,'live'),false);
  }
  assert.equal(checks,0);assert.equal(client.history(peer.pubkey).messages.length,0);assert.equal(client.store.evidence(peer.pubkey),undefined);assert.equal(client.store.pending().length,0);
 }finally{await client.close();}
});
