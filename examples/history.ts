import assert from 'node:assert/strict';
import { createDemo } from './_support.js';

// A direct message handler with explicitly selected history.
const demo = createDemo();
demo.service.handle(async ctx => {
  const { message } = ctx;
  if (message.text !== 'recap') {
    await ctx.reply(`Stored: ${message.text}`);
    return;
  }
  const first = ctx.history({ limit: 2 });
  assert.equal(first.coverage, 'local-only');
  assert.equal(first.complete, false);
  assert.ok(first.nextCursor);
  const older = ctx.history({ limit: 2, cursor: first.nextCursor });
  // Select the application's context explicitly, excluding the current request and self replies.
  const previous = [...first.messages, ...older.messages]
    .filter(item => item.direction === 'incoming' && item.id !== message.id)
    .map(item => item.text);
  assert.ok(previous.includes('Remember apples'));
  await ctx.reply(`Local context: ${previous.join(', ')}`);
});
try {
  await demo.start();
  const stored = await demo.request('Remember apples');
  assert.equal(stored, 'Stored: Remember apples'); console.log(stored);
  const recap = await demo.request('recap');
  assert.equal(recap, 'Local context: Remember apples'); console.log(recap);
  console.log('History: local-only; complete=false; paged with nextCursor');
} finally { await demo.close(); }
