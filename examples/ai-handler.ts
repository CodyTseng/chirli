import { z } from "zod";
import assert from "node:assert/strict";
import { createDemo } from "./_support.js";

// This contract belongs to the application. Replace it with your own model or agent adapter.
interface TextProcessor {
  respond(input: {
    text: string;
    messageId: string;
    sender: string;
  }): Promise<string>;
}
const mockProvider: TextProcessor = {
  // Deterministic local mock: no model, API key, HTTP request, billing, or hidden tools.
  async respond({ text }) {
    return `[MOCK provider] Received ${text.length} characters.`;
  },
};
async function main(processor: TextProcessor) {
  const demo = createDemo();
  const bot = demo.service;
  bot.command(
    {
      command: "help",
      title: "help",
      description: "Run /help in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    async (ctx) => {
      await ctx.reply("Send text to the mock processor.");
    },
  );
  bot.handle(async (ctx) => {
    // Developer decides what to send. No history, session, or prompt is sent implicitly.
    const response = await processor.respond({
      text: ctx.input.text,
      messageId: ctx.input.id, // Available for application-side idempotency.
      sender: ctx.sender,
    });
    await ctx.reply(response);
  });
  bot.catch(() => {
    /* SDK keeps failed inbox work retryable; demo support surfaces failure. */
  });
  try {
    await demo.start();
    assert.equal(
      await demo.request("/help"),
      "Send text to the mock processor.",
    );
    const response = await demo.request("Hello");
    assert.equal(response, "[MOCK provider] Received 5 characters.");
    console.log(response);
    console.log("Real model calls: 0");
  } finally {
    await demo.close();
  }
}
await main(mockProvider);
