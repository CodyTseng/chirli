import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryRelay } from "../examples/_support.js";
import { encryptAttachment } from "../src/blossom.js";
import {
  allowlist,
  Bot,
  generateSecretKey,
  nsecSigner,
  type FileAttachment,
  type Input,
} from "../src/index.js";
import {
  fileRumor,
  identitySplitEnvelope,
  localNip17Identity,
  rumor,
  standardEnvelope,
  wrap,
} from "../src/protocol.js";

const relays = ["ws://attachment-test.invalid"];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("kind 15 reaches the regular handler and returns verified Files from a persistent cache", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chirli-attachment-"));
  const secret = generateSecretKey();
  const peer = localNip17Identity();
  const denied = localNip17Identity();
  const relay = new MemoryRelay();
  const transport = relay.transport();
  const bytes = Buffer.from(
    "--AaB03x\r\nContent-Type: text/plain\r\n\r\nLocal attachment test bytes\r\n--AaB03x--\r\n",
  );
  const encrypted = encryptAttachment(bytes, {
    name: "fixture.txt",
    mimeType: "text/plain",
  });
  const requests: string[] = [];
  let foreignUrl: string;
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    switch (req.url) {
      case "/blob":
        res.end(encrypted.bytes);
        break;
      case "/corrupt":
        res.end(Buffer.alloc(encrypted.bytes.length));
        break;
      case "/stall":
        res.writeHead(200);
        res.write(encrypted.bytes.subarray(0, 1));
        break;
      case "/redirect":
        res.writeHead(307, { location: "/blob" }).end();
        break;
      case "/foreign":
        res
          .writeHead(307, {
            location: foreignUrl,
          })
          .end();
        break;
      default:
        res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address();
  assert.ok(port && typeof port !== "string");
  const origin = `http://127.0.0.1:${port.port}`;
  foreignUrl = `http://localhost:${port.port}/disallowed`;
  const attachmentDirectory = join(directory, "attachments");
  const makeBot = () =>
    new Bot({
      signer: nsecSigner(secret),
      database: join(directory, "bot.sqlite"),
      attachmentDirectory,
      blossomServers: [origin],
      transport,
      relays,
    });
  let bot = makeBot();
  const received: Input[] = [];
  let observed: FileAttachment | undefined;
  let deniedAttachment: FileAttachment | undefined;
  const hashTag = ["x", hash(encrypted.bytes)];
  const sizeTag = ["size", String(encrypted.bytes.length)];
  const tags = [...encrypted.tags, hashTag, sizeTag];
  const findTag = (name: string) => tags.filter(([tag]) => tag !== name);
  try {
    bot.use(allowlist([peer.pubkey]));
    bot.handle((ctx) => {
      received.push(ctx.input);
    });
    bot.observe((message) => {
      if (message.file) observed = message.file;
    });
    await bot.start();

    const dm = fileRumor(peer.pubkey, bot.pubkey, `${origin}/redirect`, [
      ...findTag("file-type"),
      ["file-type", "multipart/mixed; boundary=AaB03x"],
    ]);
    const receiveFile = async (
      event: ReturnType<typeof fileRumor>,
      source: "live" | "history" = "live",
      sender = peer,
    ) => {
      const accepted = await bot.receive(
        await wrap(
          event,
          sender,
          bot.pubkey,
          bot.pubkey,
          identitySplitEnvelope,
        ),
        source,
      );
      await bot.idle();
      return accepted;
    };
    assert.equal(await receiveFile(dm, "history"), true);
    assert.equal(await receiveFile(dm), false);
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, 15);
    assert.equal(received[0].text, "");
    const attachment = received[0].file;
    assert.ok(attachment);
    assert.equal(attachment.encryptedSha256, hash(encrypted.bytes));
    assert.equal(attachment.plaintextSha256, hash(bytes));
    assert.equal(attachment.encryptedSize, encrypted.bytes.length);
    assert.equal(attachment.plaintextSize, bytes.length);
    assert.equal(attachment.mimeType, "multipart/mixed;boundary=AaB03x");
    assert.equal(
      structuredClone(received[0]).file?.encryptedSha256,
      hash(encrypted.bytes),
    );
    assert.equal(observed?.name, "fixture.txt");
    assert.equal(
      bot.dmHistory(peer.pubkey).messages[0].file?.name,
      "fixture.txt",
    );
    assert.equal(
      bot.listMessages().entries[0].message.file?.name,
      "fixture.txt",
    );
    assert.equal(requests.length, 0);

    const results = await Promise.all([
      attachment.download(),
      attachment.download(),
    ]);
    for (const result of results) {
      assert.equal(result.error, null);
      assert.ok(result.file instanceof File);
      assert.equal(result.file.name, "fixture.txt");
      assert.equal(result.file.type, "multipart/mixed;boundary=aab03x");
      assert.deepEqual(
        Buffer.from(await new Response(result.file.stream()).arrayBuffer()),
        bytes,
      );
    }
    const saved = join(attachmentDirectory, bot.pubkey, hash(bytes));
    assert.deepEqual(await readFile(saved), bytes);
    assert.equal((await stat(saved)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(attachmentDirectory, bot.pubkey))).mode & 0o777,
      0o700,
    );
    assert.deepEqual(requests, ["/redirect", "/blob"]);

    assert.equal(
      (await bot.reply(dm, "received", { replyTo: dm.id })).status,
      "relay-accepted",
    );
    const followup = rumor(peer.pubkey, bot.pubkey, "next", Date.now() + 10);
    assert.equal(
      await bot.receive(
        await wrap(followup, peer, bot.pubkey, bot.pubkey, standardEnvelope),
        "live",
      ),
      true,
    );
    await bot.idle();
    const thread = await bot.thread(followup);
    assert.ok(
      thread.entries.some((entry) => entry.id === dm.id && !!entry.file),
    );

    await bot.close();
    bot = makeBot();
    bot.use(async (ctx, next) => {
      if (ctx.sender === denied.pubkey) deniedAttachment = ctx.input.file;
      await next();
    });
    bot.use(allowlist([peer.pubkey]));
    await bot.start();
    const cached = await bot.getMessage(dm.id)?.file?.download();
    assert.ok(cached?.file);
    assert.deepEqual(Buffer.from(await cached.file.arrayBuffer()), bytes);
    assert.deepEqual(requests, ["/redirect", "/blob"]);

    const resent = fileRumor(
      peer.pubkey,
      bot.pubkey,
      `${origin}/missing`,
      tags,
    );
    assert.equal(await receiveFile(resent), true);
    assert.ok((await bot.getMessage(resent.id)?.file?.download())?.file);
    assert.deepEqual(requests, ["/redirect", "/blob"]);

    // A matching ox with unknown encryption metadata cannot access the cached bytes.
    const missing = fileRumor(peer.pubkey, bot.pubkey, `${origin}/missing`, [
      ...findTag("x"),
      ["x", "a".repeat(64)],
    ]);
    assert.equal(await receiveFile(missing), true);
    assert.equal(
      (await bot.getMessage(missing.id)?.file?.download())?.error?.status,
      404,
    );
    assert.equal(requests.at(-1), "/missing");

    const badHash = fileRumor(peer.pubkey, bot.pubkey, `${origin}/blob`, [
      ...findTag("x"),
      ["x", "a".repeat(64)],
      ["fallback", `${origin}/missing`],
    ]);
    const badKey = fileRumor(peer.pubkey, bot.pubkey, `${origin}/blob`, [
      ...findTag("decryption-key"),
      ["decryption-key", "a".repeat(64)],
    ]);
    const badPlaintext = fileRumor(peer.pubkey, bot.pubkey, `${origin}/blob`, [
      ...findTag("ox"),
      ["ox", "a".repeat(64)],
    ]);
    const foreign = fileRumor(
      peer.pubkey,
      bot.pubkey,
      `${origin}/foreign`,
      findTag("ox"),
    );
    const mismatchedSize = fileRumor(
      peer.pubkey,
      bot.pubkey,
      `${origin}/blob`,
      [...findTag("size"), ["size", String(64 * 1024 * 1024 + 1)]],
    );
    for (const [event, code] of [
      [badHash, "INTEGRITY_CHECK_FAILED"],
      [badKey, "DECRYPTION_FAILED"],
      [badPlaintext, "INTEGRITY_CHECK_FAILED"],
      [foreign, "DOWNLOAD_FAILED"],
      [mismatchedSize, "INTEGRITY_CHECK_FAILED"],
    ] as const) {
      assert.equal(await receiveFile(event), true);
      const result = await bot.getMessage(event.id)?.file?.download();
      assert.equal(result?.file, null, code);
      assert.equal(result.error?.code, code);
    }
    assert.equal(requests.includes("/disallowed"), false);
    assert.equal(
      (await readdir(join(attachmentDirectory, bot.pubkey, "verified"))).length,
      1,
    );

    const withoutOx = fileRumor(peer.pubkey, bot.pubkey, `${origin}/corrupt`, [
      ...findTag("ox"),
      ["fallback", `${origin}/missing`],
      ["fallback", `${origin}/blob`],
    ]);
    assert.equal(await receiveFile(withoutOx), true);
    const fallbackFile = bot.getMessage(withoutOx.id)?.file;
    assert.ok(fallbackFile);
    assert.equal(fallbackFile.plaintextSha256, undefined);
    const fallbackResult = await fallbackFile.download();
    assert.equal(fallbackResult.error, null);
    assert.deepEqual(
      Buffer.from(await fallbackResult.file.arrayBuffer()),
      bytes,
    );
    assert.deepEqual(requests.slice(-3), ["/corrupt", "/missing", "/blob"]);
    const count = requests.length;
    assert.ok((await fallbackFile.download()).file);
    assert.equal(requests.length, count);
    assert.deepEqual(
      (await readdir(join(attachmentDirectory, bot.pubkey))).sort(),
      [hash(bytes), "verified"].sort(),
    );

    const malformed = fileRumor(peer.pubkey, bot.pubkey, `${origin}/blob`, [
      ...tags,
      hashTag,
    ]);
    assert.equal(await receiveFile(malformed), false);
    assert.equal(bot.getMessage(malformed.id), undefined);

    const blocked = fileRumor(
      denied.pubkey,
      bot.pubkey,
      `${origin}/blob`,
      tags,
    );
    assert.equal(await receiveFile(blocked, "history", denied), true);
    assert.equal(bot.getMessage(blocked.id), undefined);
    assert.ok(deniedAttachment);
    assert.equal(
      (await deniedAttachment.download()).error?.code,
      "INPUT_NOT_ADMITTED",
    );
    assert.equal(requests.length, count);

    await writeFile(saved, Buffer.alloc(bytes.length));
    const repaired = await fallbackFile.download();
    assert.ok(repaired.file);
    assert.deepEqual(await readFile(saved), bytes);
    assert.deepEqual(requests.slice(-2), ["/missing", "/blob"]);

    const stalled = fileRumor(peer.pubkey, bot.pubkey, `${origin}/stall`, [
      ...findTag("size"),
      ["fallback", `${origin}/blob`],
    ]);
    assert.equal(await receiveFile(stalled), true);
    const stalledAttachment = bot.getMessage(stalled.id)?.file;
    assert.ok(stalledAttachment);
    const timeout = AbortSignal.timeout;
    const timer = t.mock.method(AbortSignal, "timeout", (ms: number) =>
      timeout(ms >= 60_000 ? 1_500 : 100),
    );
    try {
      const result = await stalledAttachment.download();
      assert.equal(result.error, null);
      assert.deepEqual(Buffer.from(await result.file.arrayBuffer()), bytes);
      assert.deepEqual(requests.slice(-2), ["/stall", "/blob"]);
    } finally {
      timer.mock.restore();
    }

    await rename(attachmentDirectory, join(directory, "previous-attachments"));
    await writeFile(attachmentDirectory, "not a directory");
    const storageFailure = await fallbackFile.download();
    assert.equal(storageFailure.file, null);
    assert.equal(storageFailure.error?.code, "STORAGE_FAILED");
  } finally {
    await bot.close();
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
