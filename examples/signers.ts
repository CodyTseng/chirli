import { z } from "zod";
import assert from "node:assert/strict";
import { Bot, nsecSigner, generateSecretKey, type Signer } from "chirli";
import { MemoryRelay } from "./_support.js";

// Credential selection belongs at the application boundary. The bot receives a Signer.
async function run(signer: Signer, mode: "nip17" | "nip4e") {
  const relay = new MemoryRelay();
  const options = {
    mode,
    relays: ["ws://memory.invalid"],
    database: ":memory:",
  };
  const service = new Bot({ ...options, signer, transport: relay.transport() });
  const peerSigner = nsecSigner(generateSecretKey());
  const peer = new Bot({
    ...options,
    signer: peerSigner,
    transport: relay.transport(),
  });
  const bot = service;
  let response = "";

  bot.command(
    {
      command: "ping",
      title: "ping",
      description: "Run /ping in a private message.",
      scopes: ["kind:14"],
      args: z.object({
        text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
      }),
    },
    async (ctx) => {
      await ctx.reply("nsec signer pong");
    },
    {},
  );
  peer.handle(({ input }) => {
    response = input.text;
  });

  try {
    await service.start();
    await peer.start();
    await peer.send(service.pubkey, "/ping");
    await service.idle();
    await peer.idle();
    assert.equal(response, "nsec signer pong");
    console.log(`${mode}: ${response}`);
  } finally {
    await service.close();
    await peer.close();
    await peerSigner.close();
  }
}

for (const mode of ["nip4e", "nip17"] as const) {
  const signer = nsecSigner(generateSecretKey());
  try {
    await run(signer, mode);
  } finally {
    await signer.close?.();
  }
}
console.log(
  "Disposable keys only; no bunker connection or real-account access.",
);
