import {z} from 'zod';
import assert from 'node:assert/strict';
import { createDemo } from './_support.js';

// Identical application handler and lifecycle, with explicitly selected wire protocols.
// Both modes use the same signer capabilities; mode selects the messaging-key policy.
for (const mode of ['nip4e', 'nip17'] as const) {
  const demo = createDemo(mode);
  const bot = demo.service;
  bot.command({command:"ping",title:"ping",description:"Run /ping in a private message.",scopes:['kind:14'],args:z.object({"text":z.string().optional().meta({label:'Text',nipcdType:'text'})})}, async ctx => { await ctx.reply('pong'); });
  try {
    // nip17 also explicitly declares its identity key for NIP-4E compatibility.
    await demo.start();
    const response = await demo.request('/ping');
    assert.equal(response, 'pong');
    assert.equal(demo.service.history(demo.user.pubkey).coverage, 'local-only');
    console.log(`${mode}: /ping -> ${response}`);
  } finally { await demo.close(); }
}
console.log('Shared application APIs; nip17 enables identity-key NIP-4E compatibility by default.');
