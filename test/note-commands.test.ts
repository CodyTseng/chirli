import { test } from "node:test";
import assert from "node:assert/strict";
import { npubEncode } from "nostr-tools/nip19";
import { createDemo } from "../examples/_support.js";
import { configureNotes } from "../examples/live/notes-handler.js";

test("notes demo retrieves plain and qualified commands with the same validation as ingestion", async () => {
  const demo = await createDemo();
  configureNotes(demo.service);
  try {
    await demo.start();
    assert.equal(
      await demo.request("/notes"),
      "No local notes found. Send /remember <text>.",
    );
    assert.equal(
      await demo.request("/remember ordinary"),
      "Saved in local DM history.",
    );
    assert.equal(
      await demo.request(
        `/remember@nostr:${npubEncode(demo.service.pubkey)} qualified`,
      ),
      "Saved in local DM history.",
    );
    assert.equal(await demo.request("/remember"), "Usage: /remember <text>");
    assert.equal(
      await demo.request(`/remember ${"x".repeat(1001)}`),
      "Use at most 1000 characters per note.",
    );

    const notes = await demo.request("/notes");
    assert.ok(notes.includes("- ordinary"));
    assert.ok(notes.includes("- qualified"));
    assert.ok(!notes.includes("x".repeat(1001)));
    assert.equal(notes.split("\n").length, 3);
  } finally {
    await demo.close();
  }
});
