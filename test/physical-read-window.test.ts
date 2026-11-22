import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer,type WebSocket} from 'ws';
import {matchFilter,verifyEvent,type Event,type Filter} from 'nostr-tools';
import {AbstractRelay} from 'nostr-tools/abstract-relay';
import WS from 'ws';
import {WebSocketTransport,type Transport} from '../src/index.js';
import {physicalConnectionState,subscribeInbox,localReadBoundary} from '../src/relay.js';
import {PublicInbox} from '../src/public-inbox.js';
import {InboxSubscription} from '../src/inbox.js';
import {CommandCatalog} from '../src/commands.js';
import {encodeCommandDefinition} from '../src/nipcd.js';
import {localNip17Identity,rumor,wrap,standardEnvelope} from '../src/protocol.js';
import {Client} from './client.js';
import {npubEncode} from 'nostr-tools/nip19';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const until=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error('Local fixture deadline');await new Promise(resolve=>setTimeout(resolve,2));}};
async function relay(hold=false){
 const http=createServer(),wss=new WebSocketServer({noServer:true}),rawSockets=new Set<import('node:net').Socket>(),held:(()=>void)[]=[],subs=new Map<WebSocket,Map<string,Filter>>(),frames:unknown[][]=[];let connections=0;
 const fixture={url:'',frames,get connections(){return connections;},onReq:(_ws:WebSocket,_id:string,_filter:Filter)=>{},onAuth:(_ws:WebSocket,_event:Event)=>{},onPublish:(ws:WebSocket,event:Event)=>ws.send(JSON.stringify(['OK',event.id,verifyEvent(event),'fixture'])),open(){held.splice(0).forEach(run=>run());},
  push(event:Event){for(const[socket,requests]of subs)for(const[id,filter]of requests)if(matchFilter(filter,event))socket.send(JSON.stringify(['EVENT',id,event]));},
  eose(){for(const[socket,requests]of subs)for(const id of requests.keys())socket.send(JSON.stringify(['EOSE',id]));},
  disconnect(){for(const socket of wss.clients)socket.terminate();},
  async close(){for(const socket of wss.clients)socket.terminate();for(const socket of rawSockets)socket.destroy();http.closeAllConnections();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve()));}
 };
 http.on('connection',socket=>{rawSockets.add(socket);socket.on('close',()=>rawSockets.delete(socket));});
 http.on('upgrade',(request,socket,head)=>{const accept=()=>wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws));if(hold)held.push(accept);else accept();});
 wss.on('connection',socket=>{connections++;subs.set(socket,new Map());socket.on('close',()=>subs.delete(socket));socket.on('message',raw=>{const frame=JSON.parse(raw.toString());frames.push(frame);if(frame[0]==='REQ'){subs.get(socket)!.set(frame[1],frame[2]);fixture.onReq(socket,frame[1],frame[2]);}if(frame[0]==='CLOSE')subs.get(socket)?.delete(frame[1]);if(frame[0]==='AUTH')fixture.onAuth(socket,frame[1]);if(frame[0]==='EVENT')fixture.onPublish(socket,frame[1]);});});
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));fixture.url=`ws://127.0.0.1:${(http.address() as {port:number}).port}`;return fixture;
}
const wire=(eoseTimeoutMs=100)=>new WebSocketTransport({connectionTimeoutMs:1000,eoseTimeoutMs,authTimeoutMs:300,idleTimeoutMs:10000,heartbeatIntervalMs:10000,heartbeatTimeoutMs:1000});

test('physical OPEN is connected before EOSE, and EOSE/REQ/AUTH-required failures do not disconnect an OPEN socket',async()=>{
 const one=await relay(),two=await relay(),transport=wire(200);two.onReq=(ws,id)=>ws.send(JSON.stringify(['EOSE',id]));
 try{const sub=transport.subscribe([one.url],{kinds:[1]},()=>{});const failure=assert.rejects(sub.ready,{code:'RELAY_EOSE_TIMEOUT'});let settled=false;void sub.ready.then(()=>{settled=true;},()=>{settled=true;});
  await until(()=>physicalConnectionState(transport,one.url)===true);assert.equal(settled,false);await failure;assert.equal(physicalConnectionState(transport,one.url),true);assert.equal(one.connections,1);
  for(const reason of ['blocked: fixture','auth-required: fixture']){one.onReq=(ws,id)=>ws.send(JSON.stringify(['CLOSED',id,reason]));await assert.rejects(transport.subscribe([one.url],{kinds:[1]},()=>{}).ready);assert.equal(physicalConnectionState(transport,one.url),true);assert.equal(one.connections,1);}
  const other=transport.subscribe([two.url],{kinds:[1]},()=>{});await other.ready;one.disconnect();await until(()=>physicalConnectionState(transport,one.url)===false);assert.equal(physicalConnectionState(transport,two.url),true);other.close();sub.close();
 }finally{transport.close();await one.close();await two.close();}
});

test('an OPEN socket does not make a failed inbox REQ usable; explicit same-kind retry reuses the socket',async()=>{
 const fixture=await relay(),transport=wire(),identity=localNip17Identity(),author=localNip17Identity();let requests=0,calls=0;
 fixture.onReq=(socket,id)=>{requests++;socket.send(JSON.stringify(requests===1?['CLOSED',id,'blocked: first']:['EOSE',id]));};
 const definition={id:'ping',command:'ping',title:'Ping',description:'Ping',scopes:['kind:1']};const inbox=new PublicInbox(identity,{metadata:()=>undefined,saveMetadata(){}} as never,transport,{relays:[fixture.url]},[fixture.url],false,()=>[definition],()=>true,async()=>{calls++;},()=>{});
 try{await assert.rejects(inbox.start([1]));assert.equal(physicalConnectionState(transport,fixture.url),true);await inbox.start([1]);assert.equal(requests,2);assert.equal(fixture.connections,1);fixture.push(await author.sign({kind:1,created_at:1,tags:[],content:`/ping@${npubEncode(identity.pubkey)}`}));await until(()=>calls===1);await inbox.idle();}finally{inbox.stop();transport.close();await fixture.close();}
});

test('local inbox window settles once, while verified public timestamps gate late history until real EOSE',async()=>{
 const fixture=await relay(),transport=wire(60),identity=localNip17Identity(),author=localNip17Identity();let calls=0,boundary:number|undefined;
 const definition={id:'ping',command:'ping',title:'Ping',description:'Ping',scopes:['kind:1']},inbox=new PublicInbox(identity,{metadata:()=>undefined,saveMetadata(){}} as never,transport,{relays:[fixture.url]},[fixture.url],false,()=>[definition],()=>true,async()=>{calls++;},()=>{});
 const receive=inbox.receive.bind(inbox);inbox.receive=(event,...args)=>{boundary=localReadBoundary(event);return receive(event,...args);};
 const make=(created_at:number,nonce:string)=>author.sign({kind:1,created_at,tags:[['nonce',nonce]],content:`/ping@${npubEncode(identity.pubkey)}`});
 try{let completed=0;await inbox.start([1]).then(()=>{completed++;});assert.equal(physicalConnectionState(transport,fixture.url),true);fixture.push(await make(1,'old'));await until(()=>boundary!==undefined);assert.equal(calls,0);
  fixture.push(await make(Math.floor(boundary!),'ambiguous'));await tick();await inbox.idle();assert.equal(calls,0);fixture.push(await make(Math.ceil(boundary!)+1,'new'));await until(()=>calls===1);fixture.push(await make(1,'late'));await tick();await inbox.idle();assert.equal(calls,1);
  fixture.eose();await tick();await tick();fixture.push(await make(1,'real-eose-live'));await until(()=>calls===2);assert.equal(completed,1);assert.ok(!fixture.frames.some(frame=>frame[0]==='EOSE'),'no EOSE is sent to the relay');
 }finally{inbox.stop();transport.close();await fixture.close();}
});

test('fallback DM execution checks decrypted rumor time, never backdated gift-wrap time',async()=>{
 const fixture=await relay(),transport=wire(60),identity=localNip17Identity(),peer=localNip17Identity();fixture.onReq=(socket,id,filter)=>{if(!filter.kinds?.includes(1059))socket.send(JSON.stringify(['EOSE',id]));};
 const client=new Client({identity,transport,relays:[fixture.url],database:':memory:',keySync:false,recovery:false});const handled:string[]=[];client.handle(message=>{handled.push(message.text);});
 try{await client.start();const old=rumor(peer.pubkey,identity.pubkey,'old',1000),fresh=rumor(peer.pubkey,identity.pubkey,'fresh',(Math.floor(Date.now()/1000)+2)*1000);const oldWrap=await wrap(old,peer,identity.pubkey,identity.pubkey,standardEnvelope),freshWrap=await wrap(fresh,peer,identity.pubkey,identity.pubkey,standardEnvelope);assert.ok(freshWrap.created_at<=Math.floor(Date.now()/1000));fixture.push(oldWrap);fixture.push(freshWrap);await until(()=>handled.length===1);await client.idle();assert.deepEqual(handled,['fresh']);assert.equal(client.history(peer.pubkey).messages.find(message=>message.id===old.id)!.source,'history');assert.equal(client.history(peer.pubkey).messages.find(message=>message.id===fresh.id)!.source,'live');
 }finally{await client.close();transport.close();await fixture.close();}
});

test('local completion is armed only after OPEN and cannot hide AUTH, CLOSED or disconnect',async()=>{
 const held=await relay(true),transport=wire(40);let ready=0;
 try{const sub=subscribeInbox(transport,[held.url],{kinds:[1]},()=>{});void sub.ready.then(()=>{ready++;});await new Promise(resolve=>setTimeout(resolve,80));assert.equal(physicalConnectionState(transport,held.url),false);assert.equal(ready,0);held.open();await sub.ready;assert.equal(ready,1);assert.equal(physicalConnectionState(transport,held.url),true);sub.close();}finally{transport.close();await held.close();}
 const auth=await relay(),identity=localNip17Identity(),authenticatedWire=new WebSocketTransport({eoseTimeoutMs:30,authTimeoutMs:150,idleTimeoutMs:10000},template=>identity.sign(template));auth.onReq=socket=>socket.send(JSON.stringify(['AUTH','fixture-challenge']));
 try{let completed=false;const sub=subscribeInbox(authenticatedWire,[auth.url],{kinds:[1]},()=>{});void sub.ready.then(()=>{completed=true;},()=>{});const rejected=assert.rejects(sub.ready,{code:'RELAY_AUTH_TIMEOUT'});await until(()=>auth.frames.some(frame=>frame[0]==='AUTH'));await new Promise(resolve=>setTimeout(resolve,60));assert.equal(completed,false);assert.equal(physicalConnectionState(authenticatedWire,auth.url),true);await rejected;}finally{authenticatedWire.close();await auth.close();}
 const disconnected=await relay(),other=wire(100);try{const sub=subscribeInbox(other,[disconnected.url],{kinds:[1]},()=>{}),rejected=assert.rejects(sub.ready,{code:'RELAY_CLOSED'});await until(()=>disconnected.connections===1);disconnected.disconnect();await rejected;assert.equal(physicalConnectionState(other,disconnected.url),false);}finally{other.close();await disconnected.close();}
});

test('strict query, catalog withdrawals and recovery checkpoints never accept local read-window completion',async()=>{
 const fixture=await relay(),transport=wire(50),identity=localNip17Identity(),old=await identity.sign(encodeCommandDefinition({id:'old',command:'old',title:'Old',description:'Old'},1));fixture.onReq=(socket,id,filter)=>{if(filter.kinds?.includes(31992))socket.send(JSON.stringify(['EVENT',id,old]));};
 let checkpoints=0,saves=0;const store={metadata:()=>undefined,saveMetadata(){saves++;},checkpoint:()=>123,saveCheckpoint(){checkpoints++;}},errors:unknown[]=[];
 const inbox=new InboxSubscription({transport,store:store as never,relays:[fixture.url],filter:{kinds:[1059],'#p':[identity.pubkey]},localReadWindow:true,recovery:{maxPages:1},reconnect:false,receive:()=>{},error:error=>{errors.push(error);},reconnected:async()=>{}});
 try{await inbox.ready;assert.equal(checkpoints,0);assert.ok(errors.length>0);const results=await inbox.sync();assert.equal(results[0].status,'incomplete');assert.equal(checkpoints,0);await assert.rejects(transport.query([fixture.url],{kinds:[31992]}),{code:'RELAY_EOSE_TIMEOUT'});await assert.rejects(new CommandCatalog(identity,store as never,transport,[fixture.url]).sync([]));assert.equal(saves,0);assert.ok(!fixture.frames.some(frame=>frame[0]==='EVENT'),'no definition or withdrawal is published from incomplete reads');assert.equal(physicalConnectionState(transport,fixture.url),true);
 }finally{inbox.close();transport.close();await fixture.close();}
});

test('installed nostr-tools public API owns connection and synthetic EOSE, but does not expose EOSE origin',async()=>{
 const fixture=await relay(),relayClient=new AbstractRelay(fixture.url,{verifyEvent,websocketImplementation:WS as never,enableReconnect:false,enablePing:false});relayClient.onnotice=()=>{};let eoses=0;
 try{await relayClient.connect({timeout:1000});assert.equal(relayClient.connected,true);const sub=relayClient.subscribe([{kinds:[1]}],{eoseTimeout:30,onevent:()=>{},oneose:()=>{eoses++;}});await until(()=>eoses===1);assert.equal(sub.eosed,true);assert.equal(relayClient.connected,true);fixture.eose();await tick();await tick();assert.equal(eoses,1);sub.close();
  const normalized=new AbstractRelay(fixture.url+'/a//b?z=2&a=1',{verifyEvent});assert.notEqual(normalized.url,fixture.url+'/a//b?z=2&a=1','URL normalization differs from Chirli exact route preservation');
 }finally{relayClient.close();await fixture.close();}
 const custom:Transport={query:async()=>[],publish:async()=>{},subscribe:()=>({ready:Promise.resolve(),close(){}}),close(){}};assert.equal(physicalConnectionState(custom,'ws://custom.invalid'),undefined);
});


test('real EOSE before the fallback settles once; close cancels pending local completion and late intake',async()=>{
 const fixture=await relay(),transport=wire(40);let completed=0,received=0;
 fixture.onReq=(socket,id)=>socket.send(JSON.stringify(['EOSE',id]));
 try{const sub=subscribeInbox(transport,[fixture.url],{kinds:[1]},()=>{received++;});await sub.ready.then(()=>{completed++;});await new Promise(resolve=>setTimeout(resolve,70));assert.equal(completed,1);sub.close();
  fixture.onReq=()=>{};const canceled=subscribeInbox(transport,[fixture.url],{kinds:[1]},()=>{received++;});await until(()=>fixture.frames.filter(frame=>frame[0]==='REQ').length===2);canceled.close();await canceled.ready;await new Promise(resolve=>setTimeout(resolve,70));const author=localNip17Identity();fixture.push(await author.sign({kind:1,created_at:Math.floor(Date.now()/1000)+2,tags:[],content:'ignored'}));await tick();assert.equal(received,0);assert.equal(completed,1);
 }finally{transport.close();await fixture.close();}
});


test('loopback challenge-only AUTH resends once and a real ACK resolves concurrent callers',async()=>{
 const fixture=await relay(),identity=localNip17Identity(),transport=new WebSocketTransport({eoseTimeoutMs:200,publishTimeoutMs:1000,authTimeoutMs:1000},template=>identity.sign(template));
 const event=await identity.sign({kind:1,created_at:1,tags:[],content:'disposable challenge-only'});let writes=0;
 fixture.onPublish=(socket,input)=>{writes++;if(writes===1)socket.send(JSON.stringify(['AUTH','challenge-only']));else socket.send(JSON.stringify(['OK',input.id,true,'fixture']));};
 fixture.onAuth=(socket,input)=>socket.send(JSON.stringify(['OK',input.id,true,'fixture']));
 try{await Promise.all([transport.publish([fixture.url],event),transport.publish([fixture.url],event)]);assert.equal(writes,2);assert.equal(fixture.connections,1);}finally{transport.close();await fixture.close();}
});

test('loopback AUTH uses a fresh REQ and ignores old EOSE and old page entries',async()=>{
 const fixture=await relay(),identity=localNip17Identity(),peer=localNip17Identity(),transport=new WebSocketTransport({eoseTimeoutMs:1000,authTimeoutMs:1000},template=>identity.sign(template));
 const event=await peer.sign({kind:1,created_at:1,tags:[],content:'disposable page'});let old='',next='',socket:WebSocket|undefined,completed=false;
 fixture.onReq=(ws,id)=>{socket=ws;if(!old){old=id;ws.send(JSON.stringify(['EVENT',id,event]));ws.send(JSON.stringify(['AUTH','page-replacement']));}else{next=id;ws.send(JSON.stringify(['EOSE',old]));}};
 fixture.onAuth=(ws,input)=>ws.send(JSON.stringify(['OK',input.id,true,'fixture']));
 const pending=transport.query([fixture.url],{kinds:[1],limit:1});void pending.then(()=>{completed=true;});
 try{await until(()=>next!=='');assert.notEqual(next,old);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(completed,false);socket!.send(JSON.stringify(['EVENT',old,event]));socket!.send(JSON.stringify(['EVENT',next,event]));socket!.send(JSON.stringify(['EOSE',next]));const events=await pending;assert.equal(events.length,1);assert.equal(events[0].id,event.id);}finally{transport.close();await fixture.close();}
});
