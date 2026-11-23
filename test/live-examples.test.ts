import { localNip17Identity } from '../src/protocol.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { generateSecretKey, getPublicKey, type Message } from '../src/index.js';
import { configuration, ConfigurationError } from '../examples/live/config.js';
import { testRelay } from './relay.js';
import { mockBunker } from './bunker.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const entry=(name:string)=>join(root,'dist/examples/live',`${name}.js`);
// Do not inherit operator credentials, .env files or signer configuration into test children.
const cleanEnv={PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'};
async function until(check:()=>boolean,details:()=>string=()=>'',limit=500){for(let i=0;i<limit;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail(`timeout: ${details()}`);}
function launch(profile:string,file:string){
 const child=spawn(process.execPath,[`--env-file=${file}`,entry(profile)],{cwd:root,env:cleanEnv,stdio:['ignore','pipe','pipe']});let output='';child.stdout!.on('data',data=>{output+=String(data);});child.stderr!.on('data',data=>{output+=String(data);});let failed:Error|undefined;child.on('error',error=>{failed=error;});
 return{child,get output(){return output;},async ready(){await until(()=>!!failed||child.exitCode!==null||output.includes(`Chirli ${profile} ready`),()=>output);if(failed)throw failed;assert.equal(child.exitCode,null,output);assert.ok(output.includes(`Chirli ${profile} ready`),output);}};
}
async function stop(child:ChildProcess){
 if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return;
 const exited=()=>child.exitCode!==null||child.signalCode!==null,details=()=>`PID ${child.pid}`;
 child.kill('SIGTERM');
 try{await until(exited,details,300);}catch(error){
  child.kill('SIGKILL');
  await until(exited,details,100).catch(()=>{}); // Preserve the original shutdown timeout.
  throw error;
 }
 assert.equal(child.exitCode,0,'SIGTERM must drain and exit cleanly');
}
async function fixture(profile:string,mode:'nip17'|'nip4e'='nip17',partialFailure=false){
 const cleanup:(()=>Promise<void>)[]=[];
 const close=async()=>{
  const errors:unknown[]=[];
  // A failed SIGTERM assertion must not leave a loopback server open.
  for(let dispose=cleanup.pop();dispose;dispose=cleanup.pop()){
   try{await dispose();}catch(error){errors.push(error);}
  }
  if(errors.length===1)throw errors[0];
  if(errors.length>1)throw new AggregateError(errors,'Live fixture cleanup failed');
 };
 try{
  const directory=await mkdtemp(join(tmpdir(),'chirli-live-'));
  cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const relay=await testRelay(),file=join(directory,'.env.bot'),database=join(directory,'bot.sqlite'),identity=localNip17Identity();
  cleanup.push(()=>relay.close());
  // An unavailable DM replica is tolerated; command write relays must remain available.
  let relayList=relay.url;if(partialFailure){const probe=createServer();await new Promise<void>((resolve,reject)=>probe.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));relayList+=`,ws://127.0.0.1:${port}`;}
  const setup=spawnSync(process.execPath,[entry('setup'),'--relays',relay.url,'--dm-relays',relayList,'--file',file,'--database',database,'--allow',identity.pubkey,'--mode',mode],{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(setup.status,0,setup.stdout+setup.stderr);
  if(profile==='commands')await appendFile(file,'\nCHIRLI_TIMING=1\n');
  const ownGenerated=parseEnv(await readFile(file,'utf8')); // Only this test's newly generated credentials.
  assert.ok(!setup.stdout.includes(ownGenerated.CHIRLI_NSEC!));assert.ok(!setup.stdout.includes(ownGenerated.CHIRLI_STORAGE_KEY!));assert.equal((await stat(file)).mode&0o777,0o600);
  const roles=configuration(ownGenerated);
  assert.deepEqual(roles.relays,relayList.split(','));
  for(const relays of [roles.readRelays,roles.writeRelays,roles.discoveryRelays])assert.deepEqual(relays,[relay.url]);
  const botPubkey=setup.stdout.match(/Bot identity: ([0-9a-f]{64})/)![1];
  const peer=new Client({identity,relays:[relay.url],database:':memory:',storageKey:generateSecretKey()}),replies:Message[]=[];
  cleanup.push(()=>peer.close());
  peer.handle(m=>{replies.push(m);});await peer.announce();await peer.start();
  let runner=launch(profile,file);
  cleanup.push(()=>stop(runner.child));
  await runner.ready();
  return{relay,peer,replies,file,botPubkey,ownGenerated,get output(){return runner.output;},async restart(){await stop(runner.child);runner=launch(profile,file);await runner.ready();},async request(text:string){const count=replies.length;const result=await peer.send(botPubkey,text);assert.equal(result.status,'relay-accepted');await until(()=>replies.length>count,()=>runner.output);return replies[count].text;},close};
 }catch(error){
  try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Live fixture setup and cleanup failed');}
  throw error;
 }
}

test('live config supplies defaults without credentials, distinguishes absent/empty allowlist and validates rotation',()=>{
 const base={CHIRLI_NSEC:'operator-provided',CHIRLI_STORAGE_KEY:'ab'.repeat(32),CHIRLI_RELAYS:'wss://one.invalid,wss://two.invalid'};
 assert.equal(configuration({}).nsec,undefined);assert.equal(configuration({}).storageKey,undefined);assert.throws(()=>configuration({...base,CHIRLI_BUNKER:'bunker://operator'}),/only one/);
 assert.throws(()=>configuration({CHIRLI_BUNKER:'bunker://operator'}),/CHIRLI_BUNKER_CLIENT_KEY is required/);
 assert.throws(()=>configuration({CHIRLI_BUNKER:'bunker://operator',CHIRLI_BUNKER_CLIENT_KEY:'bad'}),/CHIRLI_BUNKER_CLIENT_KEY/);
 const parsed=configuration(base);assert.equal(parsed.mode,'nip17');assert.equal(parsed.allowlist,undefined);assert.equal(parsed.relays.length,2);assert.equal(parsed.database,'.chirli/bot.sqlite');
 assert.deepEqual(configuration({...base,CHIRLI_ALLOWLIST:''}).allowlist,[]);
 assert.throws(()=>configuration({...base,CHIRLI_STORAGE_KEY:'bad'}),/STORAGE_KEY/);assert.throws(()=>configuration({...base,CHIRLI_ALLOWLIST:'npub1-invalid'}),/identity/);
 assert.throws(()=>configuration({...base,CHIRLI_RELAYS:'https://wrong.invalid'}),/RELAYS/);assert.throws(()=>configuration({...base,CHIRLI_DATABASE:':memory:'}),/persistent/);
 assert.throws(()=>configuration({...base,CHIRLI_ROTATION_DAYS:'30'}),/nip4e/);
 assert.equal(configuration({...base,CHIRLI_MODE:'nip4e',CHIRLI_ROTATION_DAYS:'30',CHIRLI_LEGACY_KEYS:'7'}).rotation?.retainLegacyKeys,7);
});

test('setup never overwrites an existing identity; packaged live help needs no configuration or relay',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chirli-setup-')),file=join(directory,'.env.bot');
 try{
  for(const name of ['setup','commands','echo','session','notes']){const result=spawnSync(process.execPath,[entry(name),'--help'],{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/bot/);}
  const args=[entry('setup'),'--relays','wss://not-contacted.invalid','--file',file];const first=spawnSync(process.execPath,args,{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(first.status,0,first.stderr);const bytes=await readFile(file);
  assert.deepEqual(configuration(parseEnv(bytes.toString())).discoveryRelays,['wss://not-contacted.invalid']);
  const second=spawnSync(process.execPath,args,{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(second.status,1);assert.match(second.stderr,/already exists/);assert.deepEqual(await readFile(file),bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('setup round-trips explicit discovery relay overrides, including an empty list',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chirli-discovery-'));
 try{
  for(const [filename,override,expected] of [
   ['.env.local','ws://127.0.0.1:1234',['ws://127.0.0.1:1234']],
   ['.env.disabled','',[]],
  ] as const){
   const file=join(directory,filename);
   const setup=spawnSync(process.execPath,[entry('setup'),'--relays','wss://not-contacted.invalid','--discovery-relays',override,'--file',file],{cwd:root,env:cleanEnv,encoding:'utf8'});
   assert.equal(setup.status,0,setup.stderr);
   const parsed=configuration(parseEnv(await readFile(file,'utf8')));
   assert.deepEqual(parsed.discoveryRelays,expected);
   assert.deepEqual(parsed.writeRelays,['wss://not-contacted.invalid']);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('actual commands runner stays alive, enforces allowlist, uses split mode and exits on SIGTERM',async()=>{
 const demo=await fixture('commands','nip4e');
 try{
  const other=new Client({identity:localNip17Identity(),relays:[demo.relay.url],database:':memory:',storageKey:generateSecretKey()});
  try{
   let deniedReplies=0;other.handle(()=>{deniedReplies++;});
   await other.announce();await other.start();await other.send(demo.botPubkey,'/ping');assert.equal(await demo.request('/ping'),'pong');assert.match(await demo.request('/whoami'),new RegExp(demo.peer.pubkey));
   await until(()=>demo.output.includes('[timing] handler durationMs='),()=>demo.output);assert.match(demo.output,/\[timing\] query relay=ws:\/\/127\.0\.0\.1:/);assert.match(demo.output,/\[timing\] publish .*kinds=1059/);
   await new Promise(r=>setTimeout(r,100));assert.equal(deniedReplies,0);assert.ok(!demo.output.includes(demo.ownGenerated.CHIRLI_NSEC!));assert.ok(!demo.output.includes(demo.ownGenerated.CHIRLI_STORAGE_KEY!));
  }finally{await other.close();}
 }finally{await demo.close();}
});

test('actual echo runner uses direct Client listener on a local relay',async()=>{
 const demo=await fixture('echo');try{assert.equal(await demo.request('A usable direct listener'),'Echo: A usable direct listener');}finally{await demo.close();}
});

test('live bunker runner reconnects across processes with its configured client key', async () => {
  const remote = await mockBunker();
  const directory = await mkdtemp(join(tmpdir(), 'chirli-live-bunker-'));
  const file = join(directory, '.env.bot'), database = join(directory, 'bot.sqlite');
  const clientKey = Buffer.from(generateSecretKey());
  const writeConfig = (uri: string) => writeFile(file,
    `CHIRLI_BUNKER=${uri}\nCHIRLI_BUNKER_CLIENT_KEY=${clientKey.toString('hex')}\nCHIRLI_DATABASE=${database}\nCHIRLI_RELAYS=${remote.relay}\n`,
    { mode: 0o600 },
  );
  let runner: ReturnType<typeof launch> | undefined;
  try {
    await writeConfig(remote.uri);
    runner = launch('commands', file);
    await runner.ready();
    assert.ok(runner.output.includes(`Bot identity: ${remote.accountPubkey}`));
    await stop(runner.child);

    const reconnect = new URL(remote.uri);
    reconnect.searchParams.delete('secret');
    await writeConfig(reconnect.href);
    runner = launch('commands', file);
    await runner.ready();
    assert.ok(runner.output.includes(`Bot identity: ${remote.accountPubkey}`));
    assert.deepEqual(remote.connections, [
      { client: getPublicKey(clientKey), hasToken: true },
      { client: getPublicKey(clientKey), hasToken: false },
    ]);
  } finally {
    if (runner) await stop(runner.child);
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual session runner preserves state across process restart and does not replay history',async()=>{
 const demo=await fixture('session');try{
  assert.equal(await demo.request('/start'),'What is your name?');assert.equal(await demo.request('Ada'),'Nice to meet you, Ada.');assert.equal(await demo.request('hello'),'Hello Ada, visit 1.');
  const before=demo.replies.length;await demo.restart();assert.equal(demo.replies.length,before);assert.equal(await demo.request('again'),'Hello Ada, visit 2.');
 }finally{await demo.close();}
});

test('actual notes runner reads persistent local history after process restart',async()=>{
 const demo=await fixture('notes');try{
  assert.equal(await demo.request('/remember apples'),'Saved in local DM history.');assert.match(await demo.request('/notes'),/- apples/);await demo.restart();assert.match(await demo.request('/notes'),/- apples/);
 }finally{await demo.close();}
});

test('live runner labels an unavailable replica as warning and remains ready to reply',async()=>{
 const demo=await fixture('commands','nip17',true);try{
  await until(()=>demo.output.includes('[warning][background] RELAY_CONNECTION_FAILED'),()=>demo.output);
  assert.match(demo.output,/relay=ws:\/\/127\.0\.0\.1:\d+/);assert.match(demo.output,/ECONNREFUSED/);assert.ok(!demo.output.includes('[error][startup]'));assert.equal(await demo.request('/ping'),'pong');
 }finally{await demo.close();}
});
