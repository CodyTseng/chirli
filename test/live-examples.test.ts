import { localNip17Identity } from '../src/protocol.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { parseEnv } from 'node:util';
import { generateSecretKey, type Message } from '../src/index.js';
import { configuration, ConfigurationError } from '../examples/live/config.js';
import { testRelay } from './relay.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const entry=(name:string)=>join(root,'dist/examples/live',`${name}.js`);
// Do not inherit operator credentials, .env files or signer configuration into test children.
const cleanEnv={PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'};
async function until(check:()=>boolean,details:()=>string=()=>'',limit=500){for(let i=0;i<limit;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail(`timeout: ${details()}`);}
function launch(profile:string,file:string){
 const child=spawn(process.execPath,[`--env-file=${file}`,entry(profile)],{cwd:root,env:cleanEnv,stdio:['ignore','pipe','pipe']});let output='';child.stdout!.on('data',data=>{output+=String(data);});child.stderr!.on('data',data=>{output+=String(data);});let failed:Error|undefined;child.on('error',error=>{failed=error;});
 return{child,get output(){return output;},async ready(){await until(()=>!!failed||child.exitCode!==null||output.includes(`Chirli ${profile} ready`),()=>output);if(failed)throw failed;assert.equal(child.exitCode,null,output);assert.ok(output.includes(`Chirli ${profile} ready`),output);}};
}
async function stop(child:ChildProcess){if(child.exitCode!==null)return;child.kill('SIGTERM');try{await until(()=>child.exitCode!==null||child.signalCode!==null,()=>`PID ${child.pid}`,300);}catch(error){child.kill('SIGKILL');throw error;}assert.equal(child.exitCode,0,'SIGTERM must drain and exit cleanly');}
async function fixture(profile:string,mode:'nip17'|'nip4e'='nip17',partialFailure=false){
 const relay=await testRelay(),directory=await mkdtemp(join(tmpdir(),'chirli-live-')),file=join(directory,'.env.bot'),database=join(directory,'bot.sqlite'),identity=localNip17Identity();
 // An unavailable DM replica is tolerated; command write relays must remain available.
 let relayList=relay.url;if(partialFailure){const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));relayList+=`,ws://127.0.0.1:${port}`;}
 const setup=spawnSync(process.execPath,[entry('setup'),'--dm-relays',relayList,'--read-relays',relay.url,'--write-relays',relay.url,'--file',file,'--database',database,'--allow',identity.pubkey,'--mode',mode],{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(setup.status,0,setup.stdout+setup.stderr);
 if(profile==='commands')await appendFile(file,'\nCHIRLI_TIMING=1\n');
 const ownGenerated=parseEnv(await readFile(file,'utf8')); // Only this test's newly generated credentials.
 assert.ok(!setup.stdout.includes(ownGenerated.CHIRLI_NSEC!));assert.ok(!setup.stdout.includes(ownGenerated.CHIRLI_STORAGE_KEY!));assert.equal((await stat(file)).mode&0o777,0o600);
 const botPubkey=setup.stdout.match(/Bot identity: ([0-9a-f]{64})/)![1];
 const peer=new Client({identity,relays:[relay.url],database:':memory:',storageKey:generateSecretKey()}),replies:Message[]=[];peer.handle(m=>{replies.push(m);});await peer.announce();await peer.start();
 let runner=launch(profile,file);try{await runner.ready();}catch(error){try{await stop(runner.child);}catch{}await peer.close();await relay.close();await rm(directory,{recursive:true,force:true});throw error;}
 return{relay,peer,replies,file,botPubkey,ownGenerated,get output(){return runner.output;},async restart(){await stop(runner.child);runner=launch(profile,file);await runner.ready();},async request(text:string){const count=replies.length;const result=await peer.send(botPubkey,text);assert.equal(result.status,'relay-accepted');await until(()=>replies.length>count,()=>runner.output);return replies[count].text;},async close(){await stop(runner.child);await peer.close();await relay.close();await rm(directory,{recursive:true,force:true});}};
}

test('live config supplies defaults without credentials, distinguishes absent/empty allowlist and validates rotation',()=>{
 const base={CHIRLI_NSEC:'operator-provided',CHIRLI_STORAGE_KEY:'ab'.repeat(32),CHIRLI_RELAYS:'wss://one.invalid,wss://two.invalid'};
 assert.equal(configuration({}).nsec,undefined);assert.equal(configuration({}).storageKey,undefined);assert.throws(()=>configuration({...base,CHIRLI_BUNKER:'bunker://operator'}),/only one/);
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
  const second=spawnSync(process.execPath,args,{cwd:root,env:cleanEnv,encoding:'utf8'});assert.equal(second.status,1);assert.match(second.stderr,/already exists/);assert.deepEqual(await readFile(file),bytes);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('actual commands runner stays alive, enforces allowlist, uses split mode and exits on SIGTERM',async()=>{
 const demo=await fixture('commands','nip4e'),other=new Client({identity:localNip17Identity(),relays:[demo.relay.url],database:':memory:',storageKey:generateSecretKey()});let deniedReplies=0;other.handle(()=>{deniedReplies++;});
 try{
  await other.announce();await other.start();await other.send(demo.botPubkey,'/ping');assert.equal(await demo.request('/ping'),'pong');assert.match(await demo.request('/whoami'),new RegExp(demo.peer.pubkey));
  await until(()=>demo.output.includes('[timing] handler durationMs='),()=>demo.output);assert.match(demo.output,/\[timing\] query relay=ws:\/\/127\.0\.0\.1:/);assert.match(demo.output,/\[timing\] publish .*kinds=1059/);
  await new Promise(r=>setTimeout(r,100));assert.equal(deniedReplies,0);assert.ok(!demo.output.includes(demo.ownGenerated.CHIRLI_NSEC!));assert.ok(!demo.output.includes(demo.ownGenerated.CHIRLI_STORAGE_KEY!));
 }finally{await other.close();await demo.close();}
});

test('actual echo runner uses direct Client listener on a local relay',async()=>{
 const demo=await fixture('echo');try{assert.equal(await demo.request('A usable direct listener'),'Echo: A usable direct listener');}finally{await demo.close();}
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
