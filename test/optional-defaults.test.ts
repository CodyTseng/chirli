import { localIdentity, localNip17Identity } from '../src/protocol.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DM_RELAYS, generateSecretKey, sqliteMessageStorage, StorageEncryptionError, type Transport } from '../src/index.js';
import { SQLiteStorage } from '../src/storage-sqlite.js';
import { configuration } from '../examples/live/config.js';
import { generatedIdentity } from '../examples/live/identity.js';
import { JsonMessageStorage } from '../examples/_json-storage.js';
import { JsonStorage } from './json-storage.js';
import { MemoryRelay } from '../examples/_support.js';
import { storageContract } from './storage-contract.js';
import { rumor, wrap } from '../src/protocol.js';
import { testRelay } from './relay.js';
const root=fileURLToPath(new URL('../',import.meta.url)),env={PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'};
const defaults=['wss://relay.psstpsst.chat/','wss://nos.lol/','wss://relay.ditto.pub/'];
async function until(check:()=>boolean,details:()=>string=()=>'',limit=500){for(let i=0;i<limit;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail(`timeout: ${details()}`);}

test('SDK/live defaults use PsstPsst-derived DM relays excluding nip17.com without making network calls',async()=>{
 const config=configuration({});assert.deepEqual(config.relays,defaults);assert.deepEqual(DEFAULT_DM_RELAYS,defaults);assert.equal(config.nsec,undefined);assert.equal(config.bunker,undefined);assert.equal(config.storageKey,undefined);
 assert.deepEqual(configuration({CHIRLI_NSEC:' ',CHIRLI_STORAGE_KEY:'',CHIRLI_RELAYS:' '}).relays,defaults);
 config.relays.pop();assert.equal(DEFAULT_DM_RELAYS.length,3);
 let calls=0;const transport:Transport={query:async()=>{calls++;return[];},publish:async()=>{calls++;},subscribe:()=>{calls++;return{ready:Promise.resolve(),close(){}};},close(){}};
 const client=new Client({identity:localNip17Identity(),database:':memory:',transport});try{assert.deepEqual(client.options.relays,defaults);assert.equal(calls,0);}finally{await client.close();}
 assert.throws(()=>new Client({identity:localNip17Identity(),database:':memory:',relays:[],transport}),/nonempty/);
});

test('auto-generated identity persists privately; encrypted identity never falls back without its key',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chirli-auto-id-')),database=join(directory,'plain.sqlite'),key=generateSecretKey();
 try{
  const first=generatedIdentity(database);assert.equal(first.created,true);assert.equal((await stat(first.file)).mode&0o777,0o600);const bytes=await readFile(first.file);assert.ok(String(bytes).includes(first.nsec));
  const second=generatedIdentity(database);assert.equal(second.created,false);assert.equal(second.publicKey,first.publicKey);assert.deepEqual(await readFile(first.file),bytes);
  assert.throws(()=>generatedIdentity(database,key),(error:unknown)=>error instanceof Error&&error.name==='StorageEncryptionError'&&(error as {code?:string}).code==='STORAGE_MODE_MISMATCH');assert.deepEqual(await readFile(first.file),bytes);
  const encrypted=generatedIdentity(join(directory,'encrypted.sqlite'),key),cipher=await readFile(encrypted.file);assert.ok(!String(cipher).includes(encrypted.nsec));assert.equal(generatedIdentity(join(directory,'encrypted.sqlite'),key).publicKey,encrypted.publicKey);
  assert.throws(()=>generatedIdentity(join(directory,'encrypted.sqlite')),(error:unknown)=>error instanceof Error&&error.name==='StorageEncryptionError'&&(error as {code?:string}).code==='STORAGE_KEY_REQUIRED');assert.throws(()=>generatedIdentity(join(directory,'encrypted.sqlite'),generateSecretKey()));assert.deepEqual(await readFile(encrypted.file),cipher);
  await writeFile(first.file,'invalid');assert.throws(()=>generatedIdentity(database));assert.equal(await readFile(first.file,'utf8'),'invalid');
  const existing=join(directory,'existing.sqlite');await writeFile(existing,'existing account state');assert.throws(()=>generatedIdentity(existing),/original/);assert.equal(await readFile(existing,'utf8'),'existing account state');
 }finally{await rm(directory,{recursive:true,force:true});}
});

for(const [name,Adapter] of [['SQLite',SQLiteStorage],['custom JSON',JsonStorage]] as const){
 storageContract(`${name} no key`,async()=>{const directory=await mkdtemp(join(tmpdir(),'chirli-plain-contract-')),path=join(directory,'state');return{open:()=>new Adapter(path),cleanup:()=>rm(directory,{recursive:true,force:true})};},false);
 test(`${name}: no-key rotation/history restart works; codec mismatch cannot overwrite account state`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chirli-codec-'));
  const path = join(directory, 'core.sqlite'), identity = localNip17Identity(), peer = localIdentity(), relay = new MemoryRelay();
  const messageStorage = name === 'SQLite' ? sqliteMessageStorage(join(directory, 'messages.sqlite')) : new JsonMessageStorage(join(directory, 'messages.json'));
  const options = { mode: 'nip4e' as const, identity, database: path, messageStorage, relays: ['ws://memory.invalid'], transport: relay.transport() };
  let client = new Client(options);
  try {
    await client.announce();
    const old = client.encryptionKeys().currentPublicKey;
    await client.rotateEncryptionKey();
    const current = client.encryptionKeys().currentPublicKey;
    client.store.saveSession(peer.pubkey, { label: 'plaintext session' });
    await client.close();
    const storage = new SQLiteStorage(path);
    try {
      const plain = storage.getKeyring(identity.pubkey)!;
      assert.ok(plain.startsWith('chirli:plain:v1:'));
      assert.ok(plain.includes('secret'));
      assert.throws(() => new Client({ ...options, storageKey: generateSecretKey() }), StorageEncryptionError);
      assert.equal(storage.getKeyring(identity.pubkey), plain);
    } finally { storage.close(); }
    client = new Client({ ...options, transport: relay.transport() });
    assert.equal(client.encryptionKeys().currentPublicKey, current);
    assert.equal(client.store.session<{ label: string }>(peer.pubkey)?.label, 'plaintext session');
    await client.start();
    assert.equal(await client.receive(await wrap(rumor(peer.pubkey, identity.pubkey, 'plaintext history'), peer, identity.pubkey, old), 'live'), true);
    await client.idle();
    assert.ok(messageStorage.query(client.store.account)[0].payload.includes('plaintext history'));
  } finally {
    await client.close();
    if ('close' in messageStorage) messageStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
 });
 test(`${name}: missing key cannot downgrade existing encrypted state`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chirli-no-downgrade-'));
  const path = join(directory, 'core.sqlite'), identity = localNip17Identity(), relay = new MemoryRelay();
  const messageStorage = name === 'SQLite' ? sqliteMessageStorage(join(directory, 'messages.sqlite')) : new JsonMessageStorage(join(directory, 'messages.json'));
  const options = { identity, database: path, messageStorage, relays: ['ws://memory.invalid'], transport: relay.transport() };
  try {
    const client = new Client({ ...options, storageKey: generateSecretKey() });
    await client.close();
    const storage = new SQLiteStorage(path);
    try {
      const before = storage.getKeyring(identity.pubkey);
      assert.throws(() => new Client(options), (error: unknown) => error instanceof StorageEncryptionError && error.code === 'STORAGE_KEY_REQUIRED');
      assert.equal(storage.getKeyring(identity.pubkey), before);
    } finally { storage.close(); }
  } finally {
    if ('close' in messageStorage) messageStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
 });
}

test('real session bot runs without nsec/storage key and reuses identity/state after restart (local relay only)',async()=>{
 const relay=await testRelay(),directory=await mkdtemp(join(tmpdir(),'chirli-no-env-')),database=join(directory,'bot.sqlite'),identity=localNip17Identity(),peer=new Client({identity,relays:[relay.url],database:':memory:'}),replies:string[]=[];
 peer.handle(m=>{replies.push(m.text);});await peer.announce();await peer.start();
 const childEnv={...env,CHIRLI_RELAYS:relay.url,CHIRLI_DATABASE:database,CHIRLI_ALLOWLIST:identity.pubkey};let output='';
 const start=()=>{const child=spawn(process.execPath,[join(root,'dist/examples/live/session.js')],{cwd:directory,env:childEnv,stdio:['ignore','pipe','pipe']});output='';child.stdout.on('data',data=>{output+=String(data);});child.stderr.on('data',data=>{output+=String(data);});return child;};
 let child=start();
 const ready=async()=>{await until(()=>child.exitCode!==null||output.includes('Chirli session ready'),()=>output);assert.equal(child.exitCode,null,output);return output.match(/Bot identity: ([0-9a-f]{64})/)![1];};
 const stop=async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');try{await until(()=>child.exitCode!==null||child.signalCode!==null,()=>output,300);}catch(error){child.kill('SIGKILL');throw error;}assert.equal(child.exitCode,0,output);};
 try{
  const pub=await ready(),saved=JSON.parse(await readFile(database+'.identity.json','utf8'));assert.equal(saved.publicKey,pub);assert.ok(!output.includes(saved.payload));assert.match(output,/plaintext/);
  const request=async(text:string)=>{const before=replies.length;await peer.send(pub,text);await until(()=>replies.length>before,()=>output);return replies[before];};
  assert.equal(await request('/start'),'What is your name?');assert.equal(await request('Ada'),'Nice to meet you, Ada.');assert.equal(await request('hello'),'Hello Ada, visit 1.');await stop();
  assert.ok((await readFile(database)).includes(Buffer.from('Ada')));child=start();assert.equal(await ready(),pub);assert.equal(await request('again'),'Hello Ada, visit 2.');
 }finally{await stop();await peer.close();await relay.close();await rm(directory,{recursive:true,force:true});}
});

test('initializer uses default relay values without contacting them',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chirli-init-default-')),file=join(directory,'.env.bot');try{const result=spawnSync(process.execPath,[join(root,'dist/examples/live/setup.js'),'--file',file],{cwd:directory,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);const text=await readFile(file,'utf8');assert.ok(text.includes(defaults.join(',')));}finally{await rm(directory,{recursive:true,force:true});}
});
