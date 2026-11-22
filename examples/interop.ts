import assert from 'node:assert/strict';
import { Bot, generateSecretKey, nsecSigner } from 'chirli';
import { MemoryRelay } from './_support.js';
const serviceSigner = nsecSigner(generateSecretKey());

// Disposable accounts only. No sockets, real credentials or public relay events.
const relay = new MemoryRelay(), relays = ['wss://demo.invalid'];
const peerTransport = relay.transport();
const peerSigner = nsecSigner(generateSecretKey());
const peer = new Bot({mode:'nip4e',signer:peerSigner, relays, transport:peerTransport,
  database:':memory:', storageKey:generateSecretKey()});
const service = new Bot({mode:'nip17', signer:serviceSigner, relays,
  transport:relay.transport(), database:':memory:', storageKey:generateSecretKey()});
const bot = service;
const failures: unknown[] = [];
peer.onError(error => { failures.push(error); });
service.onError(error => { failures.push(error); });
let response = '';
peer.handle(({ message }) => { response = message.text; });
bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => { await ctx.reply('identity-key pong'); });
try {
  await peer.start();
  // Real peer account tooling may manage inbox relays separately. Demonstrate an
  // explicit signed relay list here; Chirli startup already supplies one in both modes.
  await peerTransport.publish(relays, await peerSigner.signEvent({kind:10050,
    created_at:Math.floor(Date.now()/1000), tags:relays.map(url => ['relay',url]), content:''}));
  await bot.start();
  assert.equal((await peer.send(service.pubkey, '/ping')).status, 'relay-accepted');
  await service.idle(); await peer.idle();
  if (failures.length) throw new AggregateError(failures, 'Interop demo failed');
  assert.equal(response, 'identity-key pong');
  assert.equal(service.history(peer.pubkey).messages.length, 2);
  console.log('nip4e peer -> nip17 service: /ping');
  console.log(`nip17 service -> nip4e peer: ${response}`);
  console.log('Identity-key declaration and compatible seals; all events stayed in memory.');
} finally { await bot.close(); await peer.close(); await serviceSigner.close();await peerSigner.close();}
