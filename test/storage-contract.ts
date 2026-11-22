import { localNip17Identity } from '../src/protocol.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from '../src/index.js';
import { Store } from '../src/store.js';
import { rumor } from '../src/protocol.js';
import type { StorageAdapter } from '../src/storage.js';
/** Reusable contract harness: the factory reopens the same durable database. */
export function storageContract(name:string,factory:()=>Promise<{open():StorageAdapter;cleanup():Promise<void>}>,encrypted=true){
 test(`${name}: ${encrypted?'encrypted':'plaintext'} persistence contract, atomic rollback, ordering, isolation and restart`,async()=>{
  const fixture=await factory(),key=encrypted?generateSecretKey():undefined,identity=localNip17Identity(),peer=localNip17Identity();let adapter=fixture.open();
  let store=new Store(adapter,key,`nip17:${identity.pubkey}`),other=new Store(adapter,key,identity.pubkey);
  const make=(text:string,time:number)=>{const r=rumor(peer.pubkey,identity.pubkey,text,time);return{id:r.id,sender:peer.pubkey,conversation:peer.pubkey,text,timestamp:time,source:'live' as const,direction:'incoming' as const,rumor:r};};
  const first=make('private message contract',1000),second=make('second',2000),third=make('third',2000);
  try{
   assert.equal(store.insert(first),true);assert.equal(store.insert(first),false);store.insert(second);store.insert(third);
   const page=store.history(peer.pubkey,{limit:1});assert.equal(page.messages[0].id,[second,third].sort((a,b)=>a.id.localeCompare(b.id))[0].id);assert.ok(page.nextCursor);
   assert.equal(store.history(peer.pubkey,{limit:10,cursor:page.nextCursor}).messages.length,2);
   assert.deepEqual(other.history(peer.pubkey).messages,[]);assert.equal(other.insert(first),true,'same rumor may exist in a separate mode scope');
   store.saveSession(peer.pubkey,{secret:'private session contract'});store.saveKeyring(identity.pubkey,{secret:'private keyring contract'});
   assert.equal(other.keyring<{secret:string}>(identity.pubkey)?.secret,'private keyring contract','keyring crosses mode scopes');
   store.saveCheckpoint('relay-a',20);store.saveCheckpoint('relay-a',10);assert.equal(store.checkpoint('relay-a'),20);assert.equal(store.checkpoint('relay-b'),undefined);
   store.observe(peer.pubkey,identity.pubkey,100,'b');store.observe(peer.pubkey,peer.pubkey,99,'a');assert.equal(store.evidence(peer.pubkey)?.key,identity.pubkey);store.observe(peer.pubkey,peer.pubkey,100,'a');assert.equal(store.evidence(peer.pubkey)?.key,peer.pubkey);
   const declaration=await peer.sign({kind:10044,created_at:10,tags:[['n',peer.pubkey]],content:''});store.markSplitPeer(peer.pubkey);store.rememberDeclaration(declaration);store.rememberDeclaration(await peer.sign({kind:10044,created_at:9,tags:[['n',identity.pubkey]],content:''}));assert.equal(store.declaration(peer.pubkey)?.id,declaration.id);assert.equal(store.isSplitPeer(peer.pubkey),true);
   const rolled=make('must rollback',3000);assert.throws(()=>store.transaction(()=>{store.insert(rolled);store.saveSession(peer.pubkey,{secret:'bad'});store.saveKeyring(identity.pubkey,{secret:'bad'});throw new Error('abort');}),/abort/);
   assert.ok(!store.history(peer.pubkey).messages.some(m=>m.id===rolled.id));assert.equal(store.session<{secret:string}>(peer.pubkey)?.secret,'private session contract');assert.equal(store.keyring<{secret:string}>(identity.pubkey)?.secret,'private keyring contract');
   store.putOutbox('outbox',[]);assert.throws(()=>store.transaction(()=>{store.insert(rolled);store.putOutbox('outbox',[]);}));assert.ok(!store.history(peer.pubkey).messages.some(m=>m.id===rolled.id));assert.equal(store.outbox().length,1);
   store.state(first.id,'processing');store.state(second.id,'failed');store.state(third.id,'done');assert.equal(store.pending().length,2);
   assert.equal(store.messageState(second.id),'failed');assert.equal(store.listMessages({state:'failed',limit:1}).entries[0].message.id,second.id);
   const raw=adapter.queryMessages(store.account, {states:['pending','processing','failed'],order:{time:'asc',id:'desc'}});assert.equal(JSON.stringify(raw).includes('private message contract'),!encrypted);assert.equal(String(adapter.getSession(store.account,peer.pubkey)).includes('private session contract'),!encrypted);assert.equal(String(adapter.getKeyring(identity.pubkey)).includes('private keyring contract'),!encrypted);
   raw[0].state='done';assert.equal(store.pending().length,2,'reads must be detached snapshots');
   const cipher=adapter.getKeyring(identity.pubkey)!;adapter.setKeyring(peer.pubkey,cipher);assert.throws(()=>store.keyring(peer.pubkey),'keyring identity scope binding');
   store.close();other.close();adapter.close();adapter=fixture.open();store=new Store(adapter,key,`nip17:${identity.pubkey}`);other=new Store(adapter,key,identity.pubkey);
   assert.equal(store.history(peer.pubkey).messages.length,3);assert.equal(store.messageState(second.id),'failed');assert.equal(store.session<{secret:string}>(peer.pubkey)?.secret,'private session contract');assert.equal(store.outbox()[0].id,'outbox');assert.equal(store.keyring<{secret:string}>(identity.pubkey)?.secret,'private keyring contract');
   const wrong=new Store(adapter,generateSecretKey(),store.account);assert.throws(()=>wrong.session(peer.pubkey));wrong.close();
   store.ack('outbox');assert.equal(store.outbox().length,0);
  }finally{store.close();other.close();adapter.close();await fixture.cleanup();}
 });
}
