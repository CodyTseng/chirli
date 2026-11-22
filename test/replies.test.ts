import {z} from 'zod';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bot, generateSecretKey, nsecSigner, type Message } from '../src/index.js';
import { MemoryRelay } from '../examples/_support.js';
import { localNip17Identity, rumor, standardEnvelope, wrap } from '../src/protocol.js';

for (const mode of ['nip17', 'nip4e'] as const) {
  test(`${mode}: replies use the parent rumor ID through delivery and history`, async () => {
    const relay = new MemoryRelay(), relays = ['wss://reply.invalid'];
    const senderSigner = nsecSigner(generateSecretKey()), botSigner = nsecSigner(generateSecretKey());
    const senderWire = relay.transport(), botWire = relay.transport();
    const sender = new Bot({ signer: senderSigner, mode, relays, database: ':memory:', transport: senderWire });
    const bot = new Bot({ signer: botSigner, mode, relays, database: ':memory:', transport: botWire });
    const received: Message[] = [];
    const parents: (Message | undefined)[] = [];
    sender.handle(ctx => {
      received.push(ctx.message);
      if (ctx.message.replyTo) parents.push(ctx.getMessage(ctx.message.replyTo));
    });
    bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => {
      await ctx.reply('pong', { replyTo: ctx.message.id });
    });

    try {
      await bot.start();
      await sender.start();

      const original = await sender.send(bot.pubkey, '/ping');
      await bot.idle();
      await sender.idle();
      assert.equal(received[0]?.text, 'pong');
      assert.equal(received[0]?.replyTo, original.id);
      assert.deepEqual(received[0]?.rumor.tags.find(tag => tag[0] === 'e'), ['e', original.id]);

      const followUp = await bot.send(sender.pubkey, 'Another reply', { replyTo: original.id });
      await sender.idle();
      assert.equal(received[1]?.replyTo, original.id);
      assert.deepEqual(parents.map(parent => parent?.text), ['/ping', '/ping']);
      assert.equal(sender.getMessage(followUp.id)?.replyTo, original.id);
      assert.equal(bot.getMessage(followUp.id)?.direction, 'outgoing');
      assert.equal(sender.history(bot.pubkey).messages.find(message => message.id === followUp.id)?.replyTo, original.id);
      assert.equal(bot.history(sender.pubkey).messages.find(message => message.id === followUp.id)?.replyTo, original.id);
      assert.equal(bot.history(sender.pubkey).messages.find(message => message.id === original.id)?.replyTo, undefined);

      const wraps = await senderWire.query(relays, { kinds: [1059] });
      assert.ok(wraps.length > 0);
      assert.ok(wraps.every(event => event.tags.every(tag => tag[0] !== 'e')));
      await assert.rejects(bot.send(sender.pubkey, 'Invalid reply', { replyTo: 'not-an-id' }), /lowercase hex message ID/);
      assert.equal((await botWire.query(relays, { kinds: [1059] })).length, wraps.length);
    } finally {
      await Promise.all([bot.close(), sender.close()]);
      senderWire.close();
      botWire.close();
      await Promise.all([senderSigner.close(), botSigner.close()]);
    }
  });
}

test('historical replies resolve by ID and context limits lookup to the current conversation', async () => {
  const signer = nsecSigner(generateSecretKey());
  const transport = new MemoryRelay().transport();
  const bot = new Bot({ signer, transport, relays: ['wss://reply.invalid'], database: ':memory:' });
  const peer = localNip17Identity(), other = localNip17Identity();
  const parents: (Message | undefined)[] = [];
  bot.handle(ctx => {
    if (ctx.message.replyTo) parents.push(ctx.getMessage(ctx.message.replyTo));
  });

  try {
    await bot.start();
    const original = rumor(peer.pubkey, bot.pubkey, 'Historical original');
    const reply = rumor(peer.pubkey, bot.pubkey, 'Historical reply', undefined, original.id);
    for (const message of [original, reply]) {
      assert.equal(await bot.receive(await wrap(message, peer, bot.pubkey, bot.pubkey, standardEnvelope), 'history'), true);
    }
    assert.equal(bot.getMessage(reply.id)?.source, 'history');
    const historicalReply = bot.history(peer.pubkey).messages.find(message => message.id === reply.id);
    assert.equal(historicalReply?.replyTo, original.id);
    assert.equal(bot.getMessage(original.id)?.text, 'Historical original');
    assert.deepEqual(parents, []);

    const unrelated = rumor(other.pubkey, bot.pubkey, 'Cross-conversation reply', undefined, original.id);
    await bot.receive(await wrap(unrelated, other, bot.pubkey, bot.pubkey, standardEnvelope), 'live');
    await bot.idle();
    assert.deepEqual(parents, [undefined]);
    assert.equal(bot.getMessage('0'.repeat(64)), undefined);
    assert.throws(() => bot.getMessage('invalid'), /Invalid message ID/);
  } finally {
    await bot.close();
    transport.close();
    await signer.close();
  }
});
