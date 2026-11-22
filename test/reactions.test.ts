import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventHash, nip44, verifyEvent, type Event } from 'nostr-tools';
import { Bot, generateSecretKey, nsecSigner } from '../src/index.js';
import { localIdentity, localNip17Identity, type Rumor } from '../src/protocol.js';
import { MemoryRelay } from '../examples/_support.js';
import { Client } from './client.js';

for (const mode of ['nip17', 'nip4e'] as const) {
  test(`${mode}: send a private reaction and retry the exact gift wrap`, async () => {
    const network = new MemoryRelay();
    const relays = ['wss://reactions.invalid'];
    const signer = nsecSigner(generateSecretKey());
    const identity = mode === 'nip17' ? localNip17Identity() : localIdentity();
    const peerWire = network.transport(), botWire = network.transport();
    const peer = new Client({ identity, mode, relays, database: ':memory:', transport: peerWire });
    const attempts: Event[] = [];
    let blocked = true;
    const bot = new Bot({
      signer, mode, relays, database: ':memory:',
      transport: {
        ...botWire,
        async publish(urls, event) {
          if (event.kind === 1059) {
            attempts.push(event);
            if (blocked) throw new Error('Relay unavailable');
          }
          await botWire.publish(urls, event);
        },
      },
    });
    let handled = 0;
    peer.handle(() => { handled++; });
    const sent: Awaited<ReturnType<Bot['react']>>[] = [];
    bot.command({command:"react",title:"react",description:"Run /react in a private message.",scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => { sent.push(await ctx.react('👍')); });
    const decrypt = (content: string, pubkey: string) =>
      nip44.v2.decrypt(content, nip44.v2.utils.getConversationKey(identity.encryptionKey, pubkey));
    const unwrap = (event: Event): Rumor => {
      const seal: Event = JSON.parse(decrypt(event.content, event.pubkey));
      assert.ok(verifyEvent(seal));
      const key = seal.tags.find(tag => tag[0] === 'n')?.[1] ?? seal.pubkey;
      return JSON.parse(decrypt(seal.content, key));
    };

    try {
      await peer.announce();
      await peer.start();
      await bot.start();
      const original = await peer.send(bot.pubkey, '/react');
      await bot.idle();
      assert.equal(sent[0]?.status, 'pending');
      const firstWrap = attempts[0];
      assert.ok(firstWrap);
      assert.ok(firstWrap.tags.every(tag => tag[0] !== 'e'));

      blocked = false;
      await bot.flushOutbox();
      assert.deepEqual(attempts[1], firstWrap);
      await peer.idle();
      const back = unwrap(firstWrap);
      assert.equal(back.id, sent[0]?.id);
      assert.equal(getEventHash(back), back.id);
      assert.equal(back.kind, 7);
      assert.equal(back.content, '👍');
      assert.deepEqual(back.tags.find(tag => tag[0] === 'e'), ['e', original.id]);
      assert.deepEqual(back.tags.find(tag => tag[0] === 'p'), ['p', peer.pubkey]);

      const like = await bot.react(original.id);
      assert.equal(like.status, 'relay-accepted');
      const events = await botWire.query(relays, { kinds: [1059], '#p': [peer.pubkey] });
      assert.equal(events.map(unwrap).find(event => event.id === like.id)?.content, '+');
      await peer.idle();
      assert.equal(handled, 0);
      assert.equal(peer.getMessage(back.id), undefined);
      assert.equal(bot.getMessage(back.id), undefined);
      await assert.rejects(bot.react('0'.repeat(64)), /not found in local message history/);
      await assert.rejects(bot.react(original.id, ' '), /Nonempty reaction/);
    } finally {
      await Promise.all([bot.close(), peer.close()]);
      botWire.close();
      peerWire.close();
      await signer.close();
    }
  });
}
