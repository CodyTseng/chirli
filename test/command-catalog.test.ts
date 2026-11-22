import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '../src/protocol.js';
import { Client } from './client.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter, type Event, type Filter } from 'nostr-tools';
import { commandAddress, decodeCommandDefinition, encodeCommandDefinition, encodeCommandRevocation, selectCommandDefinitions, type CommandDefinition, type BotCommandDefinition, type Transport } from '../src/index.js';
import { BotHandlers as Bot } from '../src/bot-handlers.js';
import { SQLiteStorage } from '../src/storage-sqlite.js';
import { rumor, wrap, standardEnvelope } from '../src/protocol.js';

const dm = 'ws://dm.invalid', read = 'ws://read.invalid', writes = ['ws://write-one.invalid', 'ws://write-two.invalid'];
const definition = (name: string, title = name): BotCommandDefinition & {title:string;description:string} => ({command:name, title, description:`Run ${name}`, scopes:['kind:14']});
const wireDefinition = (id: string, title = id): CommandDefinition => ({...definition(id,title),id});
const settle = async () => { for (let i=0;i<50;i++) await Promise.resolve(); };

class Network {
  data = new Map<string, Map<string, Event>>();
  publications: {relay:string;event:Event}[] = [];
  queries: {relay:string;filter:Filter}[] = [];
  businessSubscriptions = 0;
  failedRead?: string;
  reject: (relay:string,event:Event)=>boolean = () => false;
  beforePublish?: (relay:string,event:Event)=>Promise<void>;

  seed(relay: string, event: Event) {
    relay = new URL(relay).href;
    if (!this.data.has(relay)) this.data.set(relay,new Map());
    this.data.get(relay)!.set(event.id,structuredClone(event));
  }

  transport(): Transport {
    return {
      query:async(relays,filter)=>relays.flatMap(relay=>{
        this.queries.push({relay,filter});
        if(this.failedRead===relay)throw new Error('query unavailable');
        return [...(this.data.get(new URL(relay).href)?.values()??[])].filter(event=>matchFilter(filter,event))
          .sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id)).slice(0,filter.limit??10000).map(event=>structuredClone(event));
      }),
      publish:async(relays,event)=>{
        for(const relay of relays){
          this.publications.push({relay,event:structuredClone(event)});
          await this.beforePublish?.(relay,event);
          if(this.reject(relay,event))throw new Error('ACK unavailable');
          this.seed(relay,event);
          if(event.kind===5){
            const data=this.data.get(new URL(relay).href)!;
            for(const [id,stored] of data)if(stored.kind===31992&&stored.pubkey===event.pubkey&&event.tags.some(tag=>
              (tag[0]==='a'&&tag[1]===commandAddress(stored.pubkey,stored.tags.find(t=>t[0]==='d')?.[1]??'')&&event.created_at>=stored.created_at)||(tag[0]==='e'&&tag[1]===id)))data.delete(id);
          }
        }
      },
      subscribe:(_relays,filter)=>{
        if(filter.kinds?.includes(1059))this.businessSubscriptions++;
        return{ready:Promise.resolve(),close(){}};
      },close(){},
    };
  }

  all(relay = writes[0]) { return [...(this.data.get(new URL(relay).href)?.values()??[])]; }

}

function fixture(network=new Network(), identity=createIdentity(), database = ':memory:') {
  const options={identity,transport:network.transport(),dmRelays:[dm],readRelays:[read],writeRelays:writes,keySync:false as const,recovery:false as const};
  const client=new Client({...options,database});
  return{network,identity,client};
}

test('startup reconciles public definitions and withdrawals on every write relay',async()=>{
  const f=fixture(),bot=new Bot(f.client),foreign=createIdentity();
  const keep=await f.identity.sign(encodeCommandDefinition(wireDefinition('keep'),10));
  const old=await f.identity.sign(encodeCommandDefinition(wireDefinition('change','Old'),11));
  const removed=await f.identity.sign(encodeCommandDefinition(wireDefinition('remove'),12));
  const installed=await f.identity.sign({kind:10992,created_at:13,tags:[['a',commandAddress(foreign.pubkey,'foreign')]],content:''});
  for(const relay of writes)for(const event of [keep,old,removed,installed])f.network.seed(relay,event);
  bot.command(definition('keep'),()=>{});bot.command(definition('change','New'),()=>{});bot.command(definition('add'),()=>{});
  try{
    await bot.start();assert.equal(f.network.businessSubscriptions,1);
    for(const relay of writes){
      const commands=selectCommandDefinitions(f.network.all(relay),[f.identity.pubkey]).commands;
      assert.deepEqual(commands.map(command=>command.definition.id).sort(),['add','change','keep']);
      assert.equal(commands.find(command=>command.definition.id==='keep')!.event.id,keep.id);
      assert.equal(commands.find(command=>command.definition.id==='change')!.definition.title,'New');
      assert.ok(f.network.all(relay).some(event=>event.id===installed.id));
    }
    assert.ok(f.network.publications.every(item=>writes.includes(item.relay)));
    assert.equal(f.network.queries.length,writes.length);
    assert.ok(f.network.queries.every(item=>JSON.stringify(item.filter.kinds)==='[31992]'&&JSON.stringify(item.filter.authors)===JSON.stringify([f.identity.pubkey])&&item.filter['#d']===undefined));
    assert.ok(f.network.publications.every(item=>[31992,5].includes(item.event.kind)));
    const count=f.network.publications.length;await f.client.syncCommands();assert.equal(f.network.publications.length,count,'unchanged registry does not republish');
  }finally{bot.dispose();await f.client.close();}
});

test('ordinary Client preserves user-installed lists; an empty Bot withdraws its own definitions',async()=>{
  const f=fixture(),foreign=createIdentity();
  const installed=await f.identity.sign({kind:10992,created_at:10,tags:[['a',commandAddress(foreign.pubkey,'ping')]],content:''});
  const old=await f.identity.sign(encodeCommandDefinition(wireDefinition('old'),11));
  for(const relay of writes)for(const event of [installed,old])f.network.seed(relay,event);
  try{
    await f.client.start();assert.equal(f.network.publications.length,0);
    assert.equal(f.network.queries.length,0);
    await f.client.stop();const bot=new Bot(f.client);await bot.start();
    assert.equal(selectCommandDefinitions(f.network.all(),[f.identity.pubkey]).commands.length,0);
    assert.ok(f.network.all().some(event=>event.id===installed.id));bot.dispose();
  }finally{await f.client.close();}
});

test('runtime removal disables execution immediately and re-adding cannot resurrect an old handler',async()=>{
  const f=fixture(),bot=new Bot(f.client),peer=createIdentity();let oldCalls=0,newCalls=0;
  bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{oldCalls++;});
  const send=async()=>{
    await f.client.receive(await wrap(rumor(peer.pubkey,f.client.pubkey,'/ping'),peer,f.client.pubkey,f.client.pubkey,standardEnvelope),'live');
    await f.client.idle();
  };
  try{
    await bot.start();await send();assert.equal(oldCalls,1);
    await bot.removeCommand('ping');assert.deepEqual(selectCommandDefinitions(f.network.all(),[f.identity.pubkey]).commands,[]);
    await send();assert.equal(oldCalls,1);
    bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{newCalls++;});await f.client.syncCommands();await send();assert.equal(oldCalls,1);assert.equal(newCalls,1);
    await f.client.revokeCommand('ping');bot.dispose();
    const replacement=new Bot(f.client);replacement.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{newCalls++;});await f.client.syncCommands();await send();assert.equal(newCalls,2);replacement.dispose();
  }finally{bot.dispose();await f.client.close();}
});

test('failed publication retries exact definitions and withdrawals after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'chirli-catalog-')),database=join(directory,'core.sqlite');
  const network=new Network(),identity=createIdentity();
  let f=fixture(network,identity,database),bot=new Bot(f.client);
  const original=await identity.sign(encodeCommandDefinition(wireDefinition('ping','Old'),10));
  for(const relay of writes)network.seed(relay,original);
  bot.command(definition('new','New'),()=>{});
  network.reject=(relay,event)=>relay===writes[1]&&event.kind===31992;
  try{
    await assert.rejects(f.client.start(),/Command publication failed/);assert.equal(network.businessSubscriptions,0);
    assert.ok(network.all(writes[1]).some(event=>event.id===original.id));
    const pending=f.client.store.metadata<{pending:Event[]}>('command-catalog')!.pending;
    const candidate=pending.find(event=>event.kind===31992)!;
    bot.dispose();await f.client.close();network.reject=()=>false;
    f=fixture(network,identity,database);bot=new Bot(f.client);bot.command(definition('new','New'),()=>{});await bot.start();
    assert.ok(network.all(writes[1]).some(event=>event.id===candidate.id));assert.equal(selectCommandDefinitions(network.all(),[identity.pubkey]).commands.some(command=>command.definition.id==='ping'),false);
    assert.equal(f.client.store.metadata<{pending:Event[]}>('command-catalog')!.pending.length,0);
  }finally{bot.dispose();await f.client.close();rmSync(directory,{recursive:true,force:true});}
});

test('one failed write-relay query aborts synchronization without any deletion or publication',async()=>{
  const f=fixture(),bot=new Bot(f.client);f.network.failedRead=writes[1];
  try{await assert.rejects(bot.start(),/query unavailable/);assert.deepEqual(f.network.publications,[]);assert.equal(f.network.businessSubscriptions,0);}
  finally{bot.dispose();await f.client.close();}
});

test('re-registering a locally withdrawn coordinate produces a definition newer than its durable tombstone',async()=>{
  const f=fixture(),bot=new Bot(f.client);
  const old=await f.identity.sign(encodeCommandDefinition(wireDefinition('ping'),10));
  for(const relay of writes)f.network.seed(relay,old);
  const {event:deletion}=await f.client.revokeCommand('ping');
  bot.command(definition('ping'),()=>{});
  try{await bot.start();const command=selectCommandDefinitions(f.network.all(),[f.client.pubkey]).commands[0];assert.ok(command.event.created_at>deletion.created_at);}
  finally{bot.dispose();await f.client.close();}
});

test('write destinations and visibility cannot be overridden by per-command options',async()=>{
  const f=fixture(),bot=new Bot(f.client);
  try{
    assert.throws(()=>bot.command({command:"secret",title:"secret",description:"Run /secret in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{},{publish:false} as never),/always public/);
    // @ts-expect-error Exercise JavaScript callers attempting removed options.
    await assert.rejects(f.client.publishCommand(wireDefinition('redirect'),{public:true,relays:['ws://other.invalid']} as never),/always public/);
    // @ts-expect-error Exercise JavaScript callers attempting removed options.
    await assert.rejects(f.client.revokeCommand('redirect',{} as never),/always public/);
    assert.deepEqual(f.network.publications,[]);
  }finally{bot.dispose();await f.client.close();}
});

test('discovery reads author-scoped definitions and deletions without an executor membership list',async()=>{
  const f=fixture(),bot=new Bot(f.client);bot.command(definition('listed'),()=>{});
  const lookup=fixture(f.network,createIdentity());
  try{
    await bot.start();const other=await f.identity.sign(encodeCommandDefinition(wireDefinition('other'),1));
    const installed=await f.identity.sign({kind:10992,created_at:2,tags:[['a',commandAddress(f.identity.pubkey,'listed')]],content:''});
    for(const relay of writes)for(const event of [other,installed])f.network.seed(relay,event);
    f.network.queries=[];
    const result=await lookup.client.discoverCommands({authors:[f.identity.pubkey],relays:writes});
    assert.deepEqual(result.commands.map(command=>command.definition.id).sort(),['listed','other']);assert.equal('indexes' in result,false);
    assert.ok(f.network.queries.every(query=>[31992,5].includes(query.filter.kinds![0])));
    assert.ok(f.network.queries.every(query=>JSON.stringify(query.filter.authors)===JSON.stringify([f.identity.pubkey])));
    assert.ok(f.network.queries.every(query=>query.filter['#d']===undefined));
    f.network.queries=[];const filtered=await lookup.client.discoverCommands({authors:[f.identity.pubkey],ids:['other'],relays:writes});
    assert.deepEqual(filtered.commands.map(command=>command.definition.id),['other']);assert.deepEqual(f.network.queries.find(query=>query.filter.kinds?.includes(31992))!.filter['#d'],['other']);
    await bot.removeCommand('listed');assert.deepEqual((await lookup.client.discoverCommands({authors:[f.identity.pubkey],relays:writes})).commands.map(command=>command.definition.id),[]);
  }finally{bot.dispose();await f.client.close();await lookup.client.close();}
});

test('startup cancellation fences command publication after an unfinished registry query',async()=>{
  const f=fixture(),wire=f.network.transport();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),reading=new Promise<void>(resolve=>{entered=resolve;});
  const query=wire.query;wire.query=async(relays,filter)=>{if(filter.kinds?.includes(31992)){entered();await gate;}return query(relays,filter);};
  const c=new Client({identity:f.identity,transport:wire,dmRelays:[dm],writeRelays:writes,readRelays:[],database:':memory:',keySync:false,recovery:false}),bot=new Bot(c);
  bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{});
  try{
    const rejected=assert.rejects(c.start(),/synchronization canceled/);await reading;const stopped=c.stop();release();await Promise.all([rejected,stopped]);
    assert.deepEqual(f.network.publications,[]);assert.equal(f.network.businessSubscriptions,0);
  }finally{release();bot.dispose();await c.close();await f.client.close();}
});

for (const order of ['publish-first', 'bot-first'] as const) {
  test(`${order}: standalone metadata and Bot handlers have independent registration lifetimes`, async () => {
    const f = fixture(), bot = new Bot(f.client);
    const command = definition('shared');
    try {
      if (order === 'publish-first') await f.client.publishCommand({...command,id:command.command});
      bot.command(command, () => {});
      if (order === 'bot-first') await f.client.publishCommand({...command,id:command.command});
      await bot.start();

      await assert.rejects(f.client.publishCommand({ ...command,id:command.command, command: 'different' }), /registered Bot command/);
      assert.equal((await f.client.discoverCommands({ authors: [f.client.pubkey], relays: writes })).commands[0].definition.command, 'shared');

      await bot.removeCommand('shared');
      assert.equal(f.client.hasCommand('shared'), true, 'standalone publication remains registered');
      assert.equal(bot.getCommandDefinitions().length, 0);
      await f.client.revokeCommand('shared');
      assert.deepEqual(selectCommandDefinitions(f.network.all(),[f.identity.pubkey]).commands, []);
    } finally {
      await f.client.close();
      bot.dispose();
    }
  });
}

test('background announcement retry does not poll a converged catalog and still retries failed changes', async () => {
  const f = fixture(), bot = new Bot(f.client);
  bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, () => {});
  try {
    await bot.start();
    f.network.queries = [];
    await f.client.flushAnnouncements();
    assert.equal(f.network.queries.length, 0);

    f.network.reject = (_relay, event) => event.kind === 31992;
    bot.command({command:"later",title:"later",description:"Run /later in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, () => {});
    await assert.rejects(f.client.syncCommands(), /Command publication failed/);
    f.network.reject = () => false;
    f.network.queries = [];
    await f.client.flushAnnouncements();
    assert.ok(f.network.queries.length > 0);
    assert.equal(selectCommandDefinitions(f.network.all(),[f.identity.pubkey]).commands.length, 2);

    f.network.queries = [];
    await f.client.flushAnnouncements();
    assert.equal(f.network.queries.length, 0);
  } finally {
    await f.client.close();
    bot.dispose();
  }
});


test('Bot coordinates use command names and reject legacy custom identifiers in either form',async()=>{
  const f=fixture(),bot=new Bot(f.client);
  try{
    assert.throws(()=>bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{},{id:'custom'} as never),/Custom command id/);
    assert.throws(()=>bot.command({command:'ping',title:'Ping',description:'Ping',id:'custom'} as never,()=>{}),/Custom command id/);
    assert.throws(()=>bot.command({command:'ping',title:'Ping',description:'Ping',id:undefined} as never,()=>{}),/Custom command id/);
    bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{});assert.equal(bot.getCommandDefinitions()[0].id,'ping');
    await bot.start();assert.equal(decodeCommandDefinition(f.network.all().find(event=>event.kind===31992)!)!.definition.id,'ping');
    await bot.removeCommand('ping');bot.command({command:"pong",title:"pong",description:"Run /pong in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{});await f.client.syncCommands();
    assert.deepEqual(selectCommandDefinitions(f.network.all(),[f.identity.pubkey]).commands.map(command=>command.definition.id),['pong']);
  }finally{bot.dispose();await f.client.close();}
});

test('reconciliation withdraws a legacy custom coordinate when the trigger becomes its identifier',async()=>{
  const f=fixture(),bot=new Bot(f.client);
  const old=await f.identity.sign(encodeCommandDefinition({...wireDefinition('ping'),id:'legacy-coordinate'},10));
  for(const relay of writes)f.network.seed(relay,old);
  // Foreign protocol definitions keep their actual d even when it differs from the trigger.
  const decoded=decodeCommandDefinition(old)!;assert.equal(decoded.definition.id,'legacy-coordinate');assert.equal(decoded.definition.command,'ping');
  bot.command(definition('ping'),()=>{});
  try{
    await bot.start();
    for(const relay of writes)assert.deepEqual(selectCommandDefinitions(f.network.all(relay),[f.identity.pubkey]).commands.map(command=>command.definition.id),['ping']);
    assert.ok(f.network.publications.some(item=>item.event.kind===5&&item.event.tags.some(tag=>tag[0]==='a'&&tag[1]===commandAddress(f.identity.pubkey,'legacy-coordinate'))));
  }finally{bot.dispose();await f.client.close();}
});

test('fresh relay absence does not re-revoke confirmed cached definitions, and re-registration creates a new version',async()=>{
  const network=new Network(),identity=createIdentity();const old=await identity.sign(encodeCommandDefinition(wireDefinition('gone'),10));
  const store=new (await import('../src/store.js')).Store(':memory:',undefined,identity.pubkey);
  store.saveMetadata('command-catalog',{version:1,known:[old],pending:[]});
  const {CommandCatalog}=await import('../src/commands.js');const registry=new CommandCatalog(identity,store,network.transport(),writes);
  try{
    const result=await registry.sync([]);assert.deepEqual(result,{added:[],updated:[],removed:[]});assert.deepEqual(network.publications,[]);
    assert.ok(network.queries.every(query=>JSON.stringify(query.filter.kinds)==='[31992]'&&query.filter['#d']===undefined));
    await registry.sync([wireDefinition('gone')]);const replacement=selectCommandDefinitions(network.all(),[identity.pubkey]).commands[0].event;
    assert.notEqual(replacement.id,old.id);assert.ok(replacement.created_at>old.created_at);
  }finally{store.close();}
});

test('SQLite upgrade ignores obsolete control events and resumes supported pending definitions and tombstones exactly',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'chirli-command-upgrade-')),database=join(directory,'core.sqlite'),network=new Network(),identity=createIdentity();
  let f=fixture(network,identity,database);let bot:Bot|undefined;
  const candidate=await identity.sign(encodeCommandDefinition(wireDefinition('ping'),10));
  const tombstone=await identity.sign(encodeCommandRevocation(identity.pubkey,'gone',11));
  const obsolete=await identity.sign({kind:10993,created_at:Math.floor(Date.now()/1000)+1000,tags:[['a',commandAddress(identity.pubkey,'ghost')]],content:''});
  try{
    f.client.store.saveMetadata('command-catalog',{version:1,known:[candidate,tombstone,obsolete],pending:[candidate,tombstone,obsolete]});
    f.client.store.saveMetadata('announcements',{version:1,cache:{obsolete},pending:[{event:obsolete,groups:[writes]}]});
    await f.client.close();f=fixture(network,identity,database);
    const state=f.client.store.metadata<{known:Event[];pending:Event[]}>('command-catalog')!;
    assert.deepEqual(state.pending.map(event=>event.id),[candidate.id,tombstone.id]);assert.ok(state.known.every(event=>[31992,5].includes(event.kind)));
    assert.deepEqual(f.client.store.metadata<{pending:unknown[]}>('announcements')!.pending,[]);
    bot=new Bot(f.client);bot.command(definition('ping'),()=>{});await bot.start();
    assert.ok(network.publications.every(item=>[31992,5].includes(item.event.kind)));assert.ok(!network.queries.some(query=>query.filter.kinds?.includes(obsolete.kind)));
    assert.ok(network.publications.some(item=>item.event.id===candidate.id));assert.ok(network.publications.some(item=>item.event.id===tombstone.id));
    assert.ok(!network.publications.some(item=>item.event.tags.some(tag=>tag[0]==='a'&&tag[1]===commandAddress(identity.pubkey,'ghost'))));
    assert.deepEqual(f.client.store.metadata<{pending:Event[]}>('command-catalog')!.pending,[]);
    const count=network.publications.length;await f.client.syncCommands();assert.equal(network.publications.length,count);
  }finally{bot?.dispose();await f.client.close();rmSync(directory,{recursive:true,force:true});}
});

test('known truncated startup snapshots fail closed before withdrawal or publication',async()=>{
  const f=fixture(),wire=f.network.transport();const event=await f.identity.sign(encodeCommandDefinition(wireDefinition('old'),10));
  wire.query=async(_relays,filter)=>{assert.deepEqual(filter.kinds,[31992]);assert.equal(filter['#d'],undefined);return Array.from({length:1000},()=>event);};
  const client=new Client({identity:f.identity,transport:wire,dmRelays:[dm],writeRelays:writes,readRelays:[],keySync:false,recovery:false,database:':memory:'}),bot=new Bot(client);bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]},()=>{});
  try{await assert.rejects(bot.start(),/incomplete/);assert.deepEqual(f.network.publications,[]);assert.equal(f.network.businessSubscriptions,0);}finally{bot.dispose();await client.close();await f.client.close();}
});
