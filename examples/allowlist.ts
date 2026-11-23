import {z} from 'zod';
import assert from 'node:assert/strict';
import { Bot, allowlist, requestTiming, type RequestTiming, generateSecretKey, nsecSigner } from 'chirli';
import { MemoryRelay } from './_support.js';
const serviceSigner = nsecSigner(generateSecretKey());

// New disposable identities; no real credentials or network relays.
const relay=new MemoryRelay(),relays=['wss://first.demo.invalid','wss://second.demo.invalid'];
const acceptedSigner=nsecSigner(generateSecretKey()),deniedSigner=nsecSigner(generateSecretKey());
const acceptedKey=await acceptedSigner.getPublicKey(),deniedKey=await deniedSigner.getPublicKey();
const allowedKeys = [acceptedKey];
let commands=0,listeners=0,sessionWrites=0;const errors:unknown[]=[];
const service=new Bot<{ visits: number }>({signer:serviceSigner,inboundPolicy:allowlist(allowedKeys),relays,
  storageKey:generateSecretKey(),database:':memory:',transport:relay.transport()});
const makePeer=(signer:typeof acceptedSigner)=>new Bot({signer,relays,
  storageKey:generateSecretKey(),database:':memory:',transport:relay.transport()});
const accepted=makePeer(acceptedSigner),denied=makePeer(deniedSigner);
for(const client of [service,accepted,denied])client.onError(error=>{errors.push(error);});
const timings:Readonly<RequestTiming>[]=[];
service.use(requestTiming({onTiming:metric=>{timings.push(metric);}}));
service.use(async (_ctx, next) => { listeners++; await next(); });
const bot=service;
bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
  commands++;
  const visits = (await ctx.session.getItem('visits') ?? 0) + 1;
  ctx.session.setItem('visits', visits);
  sessionWrites++;
  await ctx.reply('pong');
});
try{
  await bot.start();await accepted.start();await denied.start();
  await denied.send(service.pubkey,'/ping');await service.idle();await denied.idle();assert.equal(timings.length,0);
  assert.deepEqual([commands,listeners,sessionWrites],[0,0,0]);
  assert.equal(service.history(deniedKey).messages.length,0);
  assert.equal(await service.getSession(deniedKey),undefined);
  await accepted.send(service.pubkey,'/ping');await service.idle();await accepted.idle();
  assert.equal(accepted.history(service.pubkey).messages[0].text,'pong');
  assert.deepEqual([commands,listeners,sessionWrites],[1,1,1]);
  if(errors.length)throw new AggregateError(errors,'Allowlist demo failed');
  console.log('Denied sender: no handlers, session, reply or incoming history.');
  console.log('Allowed identity: /ping -> pong; one command and one session.');
  assert.equal(timings.length,1);assert.equal(timings[0].outcome,'success');
  console.log('Omit inboundPolicy to accept all. allowlist([]) rejects every external sender.');
}finally{await bot.close();await accepted.close();await denied.close();await serviceSigner.close();await acceptedSigner.close();await deniedSigner.close();}
