import {z} from 'zod';
import { Bot, generateSecretKey, nsecSigner } from 'chirli';
import { createLocalRelay } from './_relay.js';
const aliceSigner = nsecSigner(generateSecretKey());
const bobSigner = nsecSigner(generateSecretKey());
// Disposable loopback demo. Does not contact public relays or load account keys.
const relay = await createLocalRelay(), second = await createLocalRelay();
const relays=[relay.url,second.url];
const alice = new Bot({signer:aliceSigner,relays,database:':memory:',storageKey:generateSecretKey()});
const bob = new Bot({signer:bobSigner,relays,database:':memory:',storageKey:generateSecretKey()});
const bot = bob;
bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => { await ctx.reply('pong'); });
const reply = new Promise<void>(resolve => alice.handle(({ input }) => {
  // This demo deliberately prints application text; the SDK itself never logs it.
  console.log(`Alice received: ${input.text}`); resolve();
}));
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  await alice.start(); await bot.start();
  await alice.send(bob.pubkey,'/ping');
  await Promise.race([reply, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Demo timed out')), 5000); })]);
} finally {clearTimeout(timeout);await alice.close();await bot.close();await relay.close();await second.close();await aliceSigner.close();await bobSigner.close();}
