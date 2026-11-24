import {z} from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, generateSecretKey, nsecSigner } from 'chirli';
import { JsonMessageStorage } from './_json-storage.js';
import { MemoryRelay } from './_support.js';

const directory = await mkdtemp(join(tmpdir(), 'chirli-storage-demo-'));
const historyPath = join(directory, 'messages.json');
const database = join(directory, 'core.sqlite');
const relay = new MemoryRelay();
const relays = ['wss://one.demo.invalid', 'wss://two.demo.invalid'];
const signer = nsecSigner(generateSecretKey());
const peerSigner = nsecSigner(generateSecretKey());
const storageKey = generateSecretKey();

function openService() {
  const bot = new Bot<{ visits: number }>({
    signer, storageKey, database, relays,
    messageStorage: new JsonMessageStorage(historyPath),
    transport: relay.transport(),
  });
  bot.command({command:"visit",title:"visit",description:"Run /visit in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
    const visits = (await ctx.session.getItem('visits') ?? 0) + 1;
    ctx.session.setItem('visits', visits);
    await ctx.reply(`visit ${visits}`);
  });
  return bot;
}

let service = openService();
const peer = new Bot({
  signer: peerSigner, storageKey: generateSecretKey(), database: ':memory:',
  relays, transport: relay.transport(),
});

async function visit() {
  assert.equal((await peer.send(service.pubkey, '/visit')).status, 'relay-accepted');
  await service.idle();
  await peer.idle();
}

try {
  await service.start();
  await peer.start();
  await visit();
  assert.equal(peer.dmHistory(service.pubkey).messages[0].text, 'visit 1');

  await service.close();
  service = openService();
  await service.start();
  await visit();

  // Sessions recover from SQLite; history comes from the custom message file.
  assert.equal((await service.getSession(peer.pubkey))?.visits, 2);
  assert.ok(service.dmHistory(peer.pubkey).messages.some(message => message.text === 'visit 1'));
  assert.ok(!String(await readFile(historyPath)).includes('"visits"'));
  console.log('Custom message storage restart: session visits 1 -> 2; history retained.');
  console.log('Custom storage contains message ciphertext and processing state; sessions and keys stay in internal SQLite.');
  console.log('Two demo relay URLs; memory transport only.');
} finally {
  await service.close();
  await peer.close();
  await signer.close();
  await peerSigner.close();
  await rm(directory, { recursive: true, force: true });
}
