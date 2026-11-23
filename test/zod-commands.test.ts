import {test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {npubEncode} from 'nostr-tools/nip19';
import {Bot,InvalidArgsError,allowlist,requestTiming,nsecSigner,generateSecretKey,encodeCommandDefinition,type Input,type Context,type SessionStore,type InboundPolicy} from '../src/index.js';
import {localNip17Identity} from '../src/protocol.js';
import {MemoryRelay} from '../examples/_support.js';
import {commentReply} from '../src/public-thread.js';
const urls=['ws://zod-memory.invalid'];
function fixture(mode:'nip17'|'nip4e'='nip17',inboundPolicy?:InboundPolicy,sessionStore?:SessionStore<Record<string,unknown>>){
 const network=new MemoryRelay(),user=new Bot({signer:nsecSigner(generateSecretKey()),transport:network.transport(),relays:urls,database:':memory:'}),bot=new Bot({mode,inboundPolicy,sessionStore,signer:nsecSigner(generateSecretKey()),transport:network.transport(),relays:urls,database:':memory:',publicInbox:{relays:urls}});
 return{bot,user,network,async start(){await user.start();await bot.start();},async send(text:string){const result=await user.send(bot.pubkey,text);await bot.idle();await user.idle();return result;},async close(){await bot.close();await user.close();}};
}
test('Zod object order, metadata, required and enum choices produce unchanged 31992 wire tags',async()=>{
 const {bot}=fixture();
 bot.command({command:'pick',scopes:['kind:14'],args:z.object({user:z.string().meta({label:'User',nipcdType:'pubkey'}),count:z.bigint().min(1n).max(10n).meta({label:'Count'}),mode:z.enum(['short','full']).optional().meta({label:'Mode'})})},()=>{});
 const definition=bot.getCommandDefinitions()[0];assert.deepEqual(definition.args,[{name:'user',type:'pubkey',required:true,label:'User'},{name:'count',type:'number',required:true,label:'Count'},{name:'mode',type:'enum',required:false,label:'Mode',choices:['short','full']}]);
 assert.deepEqual(encodeCommandDefinition(definition,1).tags.filter(tag=>tag[0]==='arg'),[['arg','user','pubkey','required','User'],['arg','count','number','required','Count'],['arg','mode','enum','optional','Mode','short','full']]);await bot.close();
});
test('all protocol argument kinds remain declarable, with labels defaulting to field names',async()=>{
 const {bot}=fixture();bot.command({command:'all',scopes:['kind:14'],args:z.object({pubkey:z.string().meta({nipcdType:'pubkey'}),event:z.string().meta({nipcdType:'event'}),address:z.object({kind:z.number().int(),pubkey:z.string(),identifier:z.string(),relays:z.array(z.string())}).meta({nipcdType:'address'}),relay:z.string().meta({nipcdType:'relay'}),number:z.bigint(),bool:z.boolean(),choice:z.enum(['a','b']),word:z.string(),text:z.string().optional().meta({nipcdType:'text'})})},()=>{});
 assert.deepEqual(bot.getCommandDefinitions()[0].args!.map(argument=>argument.type),['pubkey','event','address','relay','number','bool','enum','word','text']);assert.equal(bot.getCommandDefinitions()[0].args![0].label,'pubkey');await bot.close();
});
test('unsupported or ambiguous schemas fail at registration instead of guessing transforms',async()=>{
 const {bot}=fixture();for(const schema of [z.string(),z.object({n:z.number()}),z.object({v:z.string().transform(x=>x.length)}),z.object({v:z.coerce.string()}),z.object({v:z.string().trim()}),z.object({v:z.string().optional().overwrite(()=> 'x')}),z.object({v:z.string().nullable()}),z.object({v:z.string().default('x')}),z.object({v:z.array(z.string())}),z.object({v:z.union([z.string(),z.bigint()])}),z.looseObject({v:z.string()}),z.object({v:z.string().meta({nipcdType:'number'})}),z.object({v:z.string().meta({label:4})}),z.object({v:z.string().meta({nipcdType:'address'})})])assert.throws(()=>bot.command({command:'bad',scopes:['kind:14'],args:schema as never},()=>{}),/schema/);
 for(const schema of [z.object({a:z.string().optional(),b:z.string().optional()}),z.object({a:z.string().optional(),b:z.string()}),z.object({a:z.string().meta({nipcdType:'text'}),b:z.string()})])assert.throws(()=>bot.command({command:'bad',scopes:['kind:14'],args:schema},()=>{}),/optional|precede|final/);await bot.close();
});
for(const mode of ['nip17','nip4e'] as const)test(`${mode}: middleware catches decode/validation failures once; no fallback, handler or retry`,async()=>{
 const f=fixture(mode),errors:InvalidArgsError[]=[],responses:Input[]=[],operations:unknown[]=[];let handler=0,fallback=0,catchCalls=0;
 f.user.handle(ctx=>{responses.push(ctx.input);});f.bot.onError(error=>{operations.push(error);});f.bot.use(async(ctx,next)=>{assert.equal('args' in ctx,false);try{await next();}catch(error){if(!(error instanceof InvalidArgsError))throw error;errors.push(error);await ctx.reply('Usage: /count 1..10');}});
 f.bot.command({command:'count',scopes:['kind:14'],args:z.object({count:z.bigint().min(1n).max(10n)})},(ctx,args)=>{handler++;assert.equal(ctx.args,args);assert.equal(args.count,3n);});f.bot.handle(()=>{fallback++;});f.bot.catch(()=>{catchCalls++;});
 try{await f.start();const ids:string[]=[];for(const text of ['/count','/count invalid','/count 0','/count 11','/count 2 extra']){const result=await f.send(text);ids.push(result.id);assert.equal(f.bot.getMessageState(result.id),'done');}assert.equal(errors.length,5);assert.deepEqual(errors.map(error=>error.category),['decode','decode','validation','validation','decode']);assert.equal(responses.length,5);assert.equal(handler,0);assert.equal(fallback,0);assert.equal(catchCalls,0);assert.deepEqual(operations,[]);await f.bot.retryInbox({ids});assert.equal(errors.length,5);await f.send('/count 3');assert.equal(handler,1);
 }finally{await f.close();}
});
test('bot.catch observes terminal errors once; no callback means silent completion; business errors remain retryable',async()=>{
 const f=fixture();let errors=0,business=0;const raw=new Error('business error');f.bot.command({command:'need',scopes:['kind:14'],args:z.object({n:z.bigint()})},()=>{});f.bot.command({command:'fail',scopes:['kind:14']},()=>{business++;throw raw;});
 try{await f.start();const silent=await f.send('/need');assert.equal(f.bot.getMessageState(silent.id),'done');assert.equal(f.bot.history(f.user.pubkey).messages.filter(message=>message.direction==='outgoing').length,0);
 f.bot.catch(error=>{if(error instanceof InvalidArgsError){errors++;throw new Error('observer failure');}});const bad=await f.send('/need bad');assert.equal(errors,1);await f.bot.retryInbox();assert.equal(errors,1);assert.equal(f.bot.getMessageState(bad.id),'done');const failure=await f.send('/fail');assert.equal(f.bot.getMessageState(failure.id),'failed');await f.bot.retryInbox({ids:[failure.id]});assert.equal(business,2);
 }finally{await f.close();}
});
for(const mode of ['nip17','nip4e'] as const)for(const kind of [1,1111])test(`${mode} public ${kind}: only a real scoped targeted invocation reaches validation; history and repeats stay silent`,async()=>{
 const f=fixture(mode),author=localNip17Identity(),other=localNip17Identity();let errors=0,handler=0,pre=0;f.bot.use(async(_ctx,next)=>{pre++;await next();});f.bot.catch(error=>{assert.ok(error instanceof InvalidArgsError);errors++;});f.bot.command({command:'need',scopes:[`kind:${kind}`],args:z.object({n:z.bigint().min(1n)})},()=>{handler++;});
 try{await f.start();const root=await author.sign({kind:1,created_at:1,tags:[],content:'root'});const make=async(text:string,tags:string[][]=[])=>kind===1?author.sign({kind:1,created_at:2,tags,content:text}):author.sign({...commentReply(root,{id:root.id,kind:'1',author:root.pubkey},text),tags:[...commentReply(root,{id:root.id,kind:'1',author:root.pubkey},text).tags,...tags]});
 for(const text of ['/need',`/need@${npubEncode(other.pubkey)}`,'text /need'])assert.equal(await f.bot.receive(await make(text),'live',{relay:urls[0]}),false);
 const target=`@nostr:${npubEncode(f.bot.pubkey)}`;const old=await make('/need'+target);assert.equal(await f.bot.receive(old,'history',{relay:urls[0]}),true);assert.equal(await f.bot.receive(old,'live',{relay:urls[0]}),false);assert.equal(errors,0);
 for(const content of ['/need'+target+' invalid','/need'+target+' 0']){const event=await make(content);assert.equal(await f.bot.receive(event,'live',{relay:urls[0]}),true);await f.bot.idle();assert.equal(await f.bot.receive(event,'live',{relay:urls[0]}),false);}assert.equal(errors,2);assert.equal(pre,2);assert.equal(handler,0);await f.bot.retryInbox();await f.bot.stop();await f.bot.start();assert.equal(errors,2);
 }finally{await f.close();}
});
test('args-dependent authorization never grants malformed-input error response access; valid args reach authorize',async()=>{
 const f=fixture();let caught=0,authorized=0,handlers=0;f.bot.use(async(_ctx,next)=>{try{await next();}catch(error){caught++;throw error;}});f.bot.catch(async(_error,ctx)=>{caught++;await ctx.reply('must not expose');});
 f.bot.command({command:'secret',scopes:['kind:14','kind:1'],args:z.object({n:z.bigint().min(1n)})},()=>{handlers++;},{authorize:(_ctx,invocation)=>{authorized++;assert.equal(invocation.args.n,2n);return false;}});
 try{await f.start();for(const text of ['/secret','/secret nope','/secret 0','/secret 2'])await f.send(text);assert.equal(caught,0);assert.equal(authorized,1);assert.equal(handlers,0);const author=localNip17Identity();for(const suffix of ['',' nope',' 0']){const event=await author.sign({kind:1,created_at:1,tags:[],content:`/secret@${npubEncode(f.bot.pubkey)}${suffix}`});await f.bot.receive(event,'live',{relay:urls[0]});await f.bot.idle();}assert.equal(caught,0);assert.equal(f.bot.history(f.user.pubkey).messages.filter(message=>message.direction==='outgoing').length,0);
 }finally{await f.close();}
});
test('custom Zod issue messages/paths/inputs never escape through InvalidArgsError',async()=>{
 const f=fixture(),errors:InvalidArgsError[]=[];f.bot.catch(error=>{assert.ok(error instanceof InvalidArgsError);errors.push(error);});f.bot.command({command:'safe',scopes:['kind:14'],args:z.object({body:z.string().refine(()=>false,{message:'PRIVATE RAW INPUT',path:['PRIVATE PATH']})})},()=>assert.fail());
 try{await f.start();await f.send('/safe SECRET_BODY');assert.equal(errors.length,1);assert.ok(!JSON.stringify(errors[0]).includes('SECRET'));assert.ok(!JSON.stringify(errors[0]).includes('PRIVATE'));assert.deepEqual(errors[0].issues,[{code:'custom',path:['body']}]);assert.ok(Object.isFrozen(errors[0].issues));}finally{await f.close();}
});

test('application-thrown InvalidArgsError is a business error and remains retryable',async()=>{
 const f=fixture();let middleware=0,handler=0;f.bot.use(async(ctx,next)=>{if(ctx.input.text==='/middleware'){middleware++;throw new InvalidArgsError('application','validation');}await next();});f.bot.handle(ctx=>{handler++;if(ctx.input.text==='/undefined')throw undefined;throw new InvalidArgsError('application','validation');});
 try{await f.start();const a=await f.send('/middleware'),b=await f.send('ordinary'),c=await f.send('/undefined');assert.equal(f.bot.getMessageState(c.id),'failed');assert.equal(f.bot.getMessageState(a.id),'failed');assert.equal(f.bot.getMessageState(b.id),'failed');await f.bot.retryInbox();assert.equal(middleware,2);assert.equal(handler,4);}finally{await f.close();}
});

test('entry allowlist denial precedes argument validation and every error-response hook',async()=>{
 const f=fixture('nip17',allowlist([]));let validation=0,middleware=0,errors=0;
 f.bot.command({command:'need',scopes:['kind:14','kind:1'],args:z.object({n:z.bigint().refine(()=>{validation++;return false;})})},()=>assert.fail());f.bot.use(async(_ctx,next)=>{middleware++;await next();});f.bot.catch(()=>{errors++;});
 try{await f.start();await f.send('/need 0');const author=localNip17Identity(),event=await author.sign({kind:1,created_at:1,tags:[],content:`/need@${npubEncode(f.bot.pubkey)} 0`});assert.equal(await f.bot.receive(event,'live',{relay:urls[0]}),false);await f.bot.idle();assert.deepEqual([validation,middleware,errors],[0,0,0]);assert.equal(f.bot.history(f.user.pubkey).messages.length,0);}finally{await f.close();}
});

for(const mode of ['nip17','nip4e'] as const)for(const kind of [14,1,1111])test(`${mode}/${kind}: pre-authorization validator exceptions bypass reply hooks but stay failed/retryable`,async()=>{
 let saves=0,validators=0,middlewareCaught=0,botCaught=0,authorized=0,handled=0,after=0;const original=new Error('private validator failure'),operations:unknown[]=[];
 const f=fixture(mode,undefined,{get:()=>undefined,set:()=>{saves++;}});
 const metrics:{outcome:string;durationMs:number}[]=[];f.bot.use(requestTiming({onTiming:metric=>{metrics.push(metric);}}));
 f.bot.use(async(ctx,next)=>{ctx.session.setItem('staged',1);try{await next();}catch(error){middlewareCaught++;throw error;}after++;});
 f.bot.catch(()=>{botCaught++;});f.bot.onError(error=>{operations.push(error);});
 f.bot.command({command:'secure',scopes:[`kind:${kind}`],args:z.object({n:z.bigint().refine(async()=>{validators++;throw original;})})},()=>{handled++;},{authorize:()=>{authorized++;return true;}});
 try{await f.start();let id:string;
  if(kind===14)id=(await f.send('/secure 2')).id;
  else{const author=localNip17Identity(),text=`/secure@${npubEncode(f.bot.pubkey)} 2`,root=await author.sign({kind:1,created_at:1,tags:[],content:'root'});const event=await author.sign(kind===1?{kind:1,created_at:2,tags:[],content:text}:commentReply(root,{id:root.id,kind:'1',author:root.pubkey},text));id=event.id;assert.equal(await f.bot.receive(event,'live',{relay:urls[0]}),true);await f.bot.idle();}
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual([validators,middlewareCaught,botCaught,authorized,handled,after,saves],[1,0,0,0,0,1,0]);assert.deepEqual(operations,[original]);assert.deepEqual(metrics.map(metric=>metric.outcome),['failure']);assert.deepEqual(Object.keys(metrics[0]),['durationMs','outcome']);if(kind===14)assert.equal(f.bot.getMessageState(id),'failed');
  await f.bot.retryInbox({ids:[id]});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual([validators,middlewareCaught,botCaught,authorized,handled,after,saves],[2,0,0,0,0,2,0]);assert.deepEqual(operations,[original,original]);assert.deepEqual(metrics.map(metric=>metric.outcome),['failure','failure']);
 }finally{await f.close();}
});

for(const mode of ['nip17','nip4e'] as const)for(const kind of [14,1,1111])test(`${mode}/${kind}: frozen middleware ctx has no args; handler view preserves getters, methods and session`,async()=>{
 let originalContext:Context|undefined,handlers=0,saves=0;
 const f=fixture(mode,undefined,{get:()=>undefined,set:()=>{saves++;}});
 f.bot.use(async(ctx,next)=>{originalContext=ctx;Object.defineProperty(ctx,'applicationGetter',{get:()=> 'preserved',enumerable:true});Object.freeze(ctx);assert.equal('args' in ctx,false);await next();assert.equal('args' in ctx,false);});
 f.bot.command({command:'view',scopes:[`kind:${kind}`],args:z.object({n:z.bigint()})},async(ctx,args)=>{
  handlers++;assert.notEqual(ctx,originalContext);assert.equal(ctx.args,args);assert.equal(args.n,2n);assert.equal(ctx.session,originalContext!.session);assert.equal(ctx.reply,originalContext!.reply);assert.equal(Reflect.get(ctx,'applicationGetter'),'preserved');assert.equal(Object.getOwnPropertyDescriptor(ctx,'applicationGetter')!.get,Object.getOwnPropertyDescriptor(originalContext!,'applicationGetter')!.get);
  if(kind===14)assert.equal(ctx.message.rumor.id,ctx.input.id);else{assert.throws(()=>ctx.message,/only available/);assert.equal(Object.getOwnPropertyDescriptor(ctx,'message')!.get,Object.getOwnPropertyDescriptor(originalContext!,'message')!.get);}
  ctx.session.setItem('shared',args.n);await ctx.reply('valid');
 });
 try{await f.start();if(kind===14)await f.send('/view 2');else{const author=localNip17Identity(),text=`/view@${npubEncode(f.bot.pubkey)} 2`,root=await author.sign({kind:1,created_at:1,tags:[],content:'root'});const event=await author.sign(kind===1?{kind:1,created_at:2,tags:[],content:text}:commentReply(root,{id:root.id,kind:'1',author:root.pubkey},text));await f.bot.receive(event,'live',{relay:urls[0]});await f.bot.idle();}assert.equal(handlers,1);assert.equal(saves,1);}finally{await f.close();}
});

test('validator exceptions without command authorize preserve the existing business error chain',async()=>{
 const f=fixture(),original=new Error('validator');let middleware=0,observer=0;
 f.bot.command({command:'throw',scopes:['kind:14'],args:z.object({n:z.bigint().refine(()=>{throw original;})})},()=>assert.fail());f.bot.use(async(_ctx,next)=>{try{await next();}catch(error){assert.equal(error,original);middleware++;throw error;}});f.bot.catch(error=>{assert.equal(error,original);observer++;});
 try{await f.start();const result=await f.send('/throw 2');assert.deepEqual([middleware,observer],[1,1]);assert.equal(f.bot.getMessageState(result.id),'failed');}finally{await f.close();}
});

test('reserved __proto__ schema field is rejected and the runtime removal API is absent',async()=>{
 const f=fixture();try{const shape=Object.fromEntries([['__proto__',z.string()]]);assert.equal(Object.hasOwn(shape,'__proto__'),true);assert.throws(()=>f.bot.command({command:'unsafe',scopes:['kind:14'],args:z.object(shape)},()=>{}),/reserved top-level/);assert.equal('removeCommand' in f.bot,false);}finally{await f.close();}
});

test('deferred validator failures retain processing semantics without registering timing or exposing an internal API',async()=>{
 const f=fixture(),original=new Error('validator'),operations:unknown[]=[];let caught=0;
 f.bot.command({command:'secure',scopes:['kind:14'],args:z.object({n:z.bigint().refine(()=>{throw original;})})},()=>assert.fail(),{authorize:()=>assert.fail('authorization must not run')});
 f.bot.catch(()=>{caught++;});f.bot.onError(error=>{operations.push(error);});
 try{await f.start();const result=await f.send('/secure 1');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.bot.getMessageState(result.id),'failed');assert.equal(caught,0);assert.deepEqual(operations,[original]);assert.equal('markDeferredRequestFailure' in await import('../src/index.js'),false);}finally{await f.close();}
});
