import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDecipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import { getEventHash, nip44, verifyEvent, type Event } from 'nostr-tools';
import { Bot, DEFAULT_BLOSSOM_SERVERS, generateSecretKey, getPublicKey, nsecSigner, type Rumor } from '../src/index.js';
import { npubEncode } from 'nostr-tools/nip19';
import { commentReply, threadStructure } from '../src/public-thread.js';
import { MemoryRelay } from '../examples/_support.js';

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const relays = ['wss://demo.invalid'];

test('configured Blossom servers are announced in order and kind 15 delivers only an encrypted upload', async () => {
  const plain = Buffer.from('a disposable file attachment '.repeat(4));
  const fileName = 'local-fixture.txt';
  const requests: { path: string; token: string; bytes: Buffer; headers: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const token = req.headers.authorization?.replace(/^Nostr /, '') ?? '';
    requests.push({ path: req.url!, token, bytes, headers: req.headers });
    if (req.url === '/redirect/upload') {
      res.writeHead(307, { location: '/must-not-follow' }).end();
    } else if (req.url === '/bad/upload') {
      res.end(JSON.stringify({ url: origin + '/' + hash(bytes) + '.bin', sha256: 'f'.repeat(64), size: bytes.length }));
    } else if (req.url === '/mirror-ok/mirror') {
      const { url } = JSON.parse(bytes.toString('utf8'));
      const primary = requests.find(request => request.path === '/legacy/upload')!.bytes;
      res.writeHead(201).end(JSON.stringify({ url, sha256: hash(primary), size: primary.length }));
    } else if (req.url === '/mirror-fail/mirror') {
      res.writeHead(501).end();
    } else if (req.url === '/legacy/upload' && requests.filter(r => r.path === req.url).length === 1) {
      res.writeHead(401).end();
    } else {
      res.writeHead(201).end(JSON.stringify({ url: origin + '/legacy/' + hash(bytes) + '.bin', sha256: hash(bytes), size: bytes.length }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address();
  assert.ok(port && typeof port !== 'string');
  const origin = `http://127.0.0.1:${port.port}`;
  const relay = new MemoryRelay(), reader = relay.transport(), real = relay.transport();
  const identity = nsecSigner(generateSecretKey()), peerSecret = generateSecretKey(), peer = getPublicKey(peerSecret);
  let uploadSignatures = 0;
  const signer = { ...identity, signEvent(template: Parameters<typeof identity.signEvent>[0]) {
    if (template.kind === 24242) uploadSignatures++;
    return identity.signEvent(template);
  } };
  let failDelivery = true;
  const transport = { ...real, async publish(urls: string[], event: Event) {
    if (event.kind === 1059 && failDelivery) throw new Error('test relay temporarily unavailable');
    await real.publish(urls, event);
  }};
  const servers = ['/redirect', '/bad', '/legacy', '/mirror-ok', '/mirror-fail'].map(path => origin + path);
  const bot = new Bot({ signer, database: ':memory:', transport, relays, keySync: false, blossomServers: [...servers, servers[1] + '/'] });
  try {
    await bot.start();
    const [announcement] = await reader.query(relays, { kinds: [10063], authors: [bot.pubkey] });
    assert.deepEqual(announcement.tags, servers.map(url => ['server', url]));
    const result = await bot.sendFile(peer, plain, { mimeType: 'text/plain', name: fileName });
    assert.equal(result.status, 'pending');
    assert.deepEqual(requests.slice(0, 4).map(x => x.path), ['/redirect/upload', '/bad/upload', '/legacy/upload', '/legacy/upload']);
    assert.deepEqual(requests.slice(4).map(x => x.path).sort(), ['/mirror-fail/mirror', '/mirror-ok/mirror']);
    const bytes = requests[0].bytes, sha256 = hash(bytes);
    assert.equal(bytes.length, plain.length + 16);
    assert.notDeepEqual(bytes.subarray(0, plain.length), plain);
    for (const attempt of requests.slice(0, 4)) {
      assert.deepEqual(attempt.bytes, bytes);
      assert.equal(attempt.headers['content-length'], String(bytes.length));
      assert.equal(attempt.headers['content-type'], 'application/octet-stream');
      assert.equal(attempt.headers['x-sha-256'], sha256);
      const auth = JSON.parse(Buffer.from(attempt.token, 'base64').toString('utf8')) as Event;
      assert.ok(verifyEvent(auth));
      assert.equal(auth.kind, 24242);
      assert.equal(auth.pubkey, bot.pubkey);
      assert.deepEqual(auth.tags.slice(0, 4), [['t', 'upload'], ['x', sha256], ['size', String(bytes.length)], ['server', '127.0.0.1']]);
      assert.equal(auth.tags[4][0], 'expiration');
      assert.equal(Number(auth.tags[4][1]), auth.created_at + 300);
      assert.ok(!JSON.stringify(auth).includes(fileName));
      assert.ok(!JSON.stringify(auth).includes(hash(plain)));
    }
    assert.equal(Buffer.from(requests[2].token, 'base64').toString('base64url'), requests[2].token);
    assert.equal(Buffer.from(requests[2].token, 'base64').toString('base64'), requests[3].token);
    assert.equal(uploadSignatures, 1, 'all mirrors reuse the successful signed upload authorization');
    const primaryAuthorization = Buffer.from(requests[3].token, 'base64').toString('utf8');
    for (const attempt of requests.slice(4)) {
      assert.deepEqual(JSON.parse(attempt.bytes.toString('utf8')), { url: origin + '/legacy/' + sha256 });
      assert.equal(attempt.headers['content-type'], 'application/json');
      assert.equal(attempt.headers['x-content-type'], 'application/octet-stream');
      assert.equal(attempt.headers['x-content-length'], String(bytes.length));
      assert.equal(Buffer.from(attempt.token, 'base64').toString('utf8'), primaryAuthorization);
      const auth = JSON.parse(Buffer.from(attempt.token, 'base64').toString('utf8')) as Event;
      assert.ok(verifyEvent(auth));
      assert.deepEqual(auth.tags.slice(0, 4), [['t', 'upload'], ['x', sha256], ['size', String(bytes.length)], ['server', '127.0.0.1']]);
    }
    failDelivery = false;
    await bot.flushOutbox();
    assert.equal(requests.length, 6, 'relay retry must not re-upload or mirror');
    const [wrap] = await reader.query(relays, { kinds: [1059], '#p': [peer] });
    assert.ok(verifyEvent(wrap));
    const seal = JSON.parse(nip44.v2.decrypt(wrap.content, nip44.v2.utils.getConversationKey(peerSecret, wrap.pubkey))) as Event;
    assert.ok(verifyEvent(seal));
    assert.equal(seal.pubkey, bot.pubkey);
    const rumor = JSON.parse(nip44.v2.decrypt(seal.content, nip44.v2.utils.getConversationKey(peerSecret, seal.pubkey)));
    assert.equal(rumor.kind, 15);
    assert.equal(rumor.id, result.id);
    assert.equal(rumor.id, getEventHash(rumor));
    assert.equal(rumor.content, origin + '/legacy/' + sha256 + '.bin');
    const tags = Object.fromEntries(rumor.tags);
    assert.equal(tags['file-type'], 'text/plain');
    assert.equal(tags['encryption-algorithm'], 'aes-gcm');
    assert.equal(tags.name, fileName);
    assert.equal(tags.x, sha256);
    assert.equal(tags.ox, hash(plain));
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(tags['decryption-key'], 'hex'), Buffer.from(tags['decryption-nonce'], 'hex'));
    decipher.setAuthTag(bytes.subarray(-16));
    assert.deepEqual(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]), plain);
    assert.deepEqual(await reader.query(relays, { kinds: [15, 24242] }), []);
  } finally {
    await bot.close();
    await signer.close();
    real.close();
    reader.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('An explicit empty Blossom list disables uploads; credentials are rejected before publication', async () => {
  const transport = new MemoryRelay().transport(), signer = nsecSigner(generateSecretKey());
  const options = { signer, database: ':memory:', transport, relays, keySync: false as const };
  const bot = new Bot({ ...options, blossomServers: [] });
  const invalid = new Bot({ ...options, blossomServers: ['https://example.invalid/?token=private'] });
  try {
    await bot.start();
    assert.deepEqual(await transport.query(relays, { kinds: [10063] }), []);
    await assert.rejects(bot.sendFile(getPublicKey(generateSecretKey()), Buffer.from('fixture')), /Configure blossomServers/);
    await assert.rejects(invalid.start(), /without credentials, query or fragment/);
  } finally {
    await Promise.all([bot.close(), invalid.close()]);
    await signer.close();
    transport.close();
  }
});

test('startup advertises the default Blossom server without uploading a file', async () => {
  const transport = new MemoryRelay().transport(), signer = nsecSigner(generateSecretKey());
  const bot = new Bot({ signer, database: ':memory:', transport, relays, keySync: false });
  try {
    await bot.start();
    assert.deepEqual(DEFAULT_BLOSSOM_SERVERS, ['https://blossom.jumble.social/']);
    const [announcement] = await transport.query(relays, { kinds: [10063], authors: [bot.pubkey] });
    assert.deepEqual(announcement.tags, [['server', 'https://blossom.jumble.social/']]);
  } finally {
    await bot.close();
    await signer.close();
    transport.close();
  }
});

test('uploadFile snapshots the input bytes and returns metadata without sending a Nostr event', async () => {
  const requests: { bytes: Buffer; type?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), sha256 = hash(bytes);
    requests.push({ bytes, type: req.headers['content-type'] });
    res.writeHead(201).end(JSON.stringify({ url: origin + '/' + sha256 + '.bin', sha256, size: bytes.length }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new MemoryRelay().transport(), signer = nsecSigner(generateSecretKey());
  const bot = new Bot({ signer, transport, relays, database: ':memory:', keySync: false, blossomServers: [origin] });
  try {
    await bot.start();
    const before = await transport.query(relays, {});
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), original = Buffer.from(data);
    const uploaded = bot.uploadFile(data, { mimeType: 'image/png' });
    data.fill(0);
    const sha256 = hash(original);
    assert.deepEqual(await uploaded, { url: origin + '/' + sha256 + '.bin', sha256, size: original.length, mimeType: 'image/png' });
    assert.deepEqual(requests, [{ bytes: original, type: 'image/png' }]);
    const opaque = new Uint8Array([0, 255, 99]);
    assert.equal((await bot.uploadFile(opaque)).mimeType, 'application/octet-stream');
    assert.deepEqual(requests[1], { bytes: Buffer.from(opaque), type: 'application/octet-stream' });
    assert.deepEqual(await transport.query(relays, {}), before);
  } finally {
    await bot.close();
    await signer.close();
    transport.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('replyFile routes by the authenticated anchor inside and outside handlers', async () => {
  const plain = Buffer.from('synthetic image bytes');
  const uploads: { bytes: Buffer; type?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), sha256 = hash(bytes);
    uploads.push({ bytes, type: req.headers['content-type'] });
    res.writeHead(201).end(JSON.stringify({ url: origin + '/' + sha256 + '.bin', sha256, size: bytes.length }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const network = new MemoryRelay(), wire = network.transport(), peerWire = network.transport();
  const source = 'wss://source.invalid', write = 'wss://write.invalid';
  const signer = nsecSigner(generateSecretKey()), peerKey = generateSecretKey(), peerSigner = nsecSigner(peerKey);
  const delivery: { relays: string[]; event: Event }[] = [];
  let rejectPublic = false;
  const transport = { ...wire, async publish(destinations: string[], event: Event) {
    if (event.kind === 1111 && rejectPublic) throw new Error('Public write relay unavailable');
    delivery.push({ relays: destinations, event });
    await wire.publish(destinations, event);
  }};
  const bot = new Bot({ signer, database: ':memory:', transport, relays, writeRelays: [write], publicInbox: { relays: [source] }, blossomServers: [origin] });
  const peer = new Bot({ signer: peerSigner, database: ':memory:', transport: peerWire, relays, blossomServers: [] });
  const anchors = new Map<number, Event | Rumor>();
  const options = { mimeType: 'image/png', name: 'fixture.png' };
  bot.command({ command: 'file', scopes: ['kind:14', 'kind:1', 'kind:1111'] }, async ctx => {
    anchors.set(ctx.input.event.kind, structuredClone(ctx.input.event));
    ctx.input.event.content = 'mutated';
    await ctx.replyFile(plain, options);
  });
  try {
    await peer.start();
    await bot.start();
    await peer.send(bot.pubkey, '/file');
    await bot.idle();
    const dm = anchors.get(14)!;
    const dmLater = await bot.replyFile(dm, plain, options);
    assert.equal(dmLater.status, 'relay-accepted');
    assert.equal(uploads.length, 2);
    const wraps = await peerWire.query(relays, { kinds: [1059], '#p': [peer.pubkey] });
    const seals = wraps.map(wrap =>
      JSON.parse(nip44.v2.decrypt(wrap.content, nip44.v2.utils.getConversationKey(peerKey, wrap.pubkey))) as Event,
    ).filter(seal => seal.pubkey === bot.pubkey);
    assert.equal(seals.length, 2);
    for (const seal of seals) {
      assert.ok(verifyEvent(seal));
      const rumor: Rumor = JSON.parse(nip44.v2.decrypt(seal.content, nip44.v2.utils.getConversationKey(peerKey, seal.pubkey)));
      assert.equal(rumor.kind, 15);
      const tags = Object.fromEntries(rumor.tags);
      assert.equal(tags.e, dm.id);
      assert.equal(tags['file-type'], 'image/png');
      assert.equal(tags.name, 'fixture.png');
      const uploaded = uploads.find(upload => hash(upload.bytes) === tags.x)!;
      assert.equal(uploaded.type, 'application/octet-stream');
      assert.notDeepEqual(uploaded.bytes, plain);
    }

    const root = await peerSigner.signEvent({ kind: 1, created_at: 10, content: 'root', tags: [] });
    await peerWire.publish([source], root);
    const reply = commentReply(root, { id: root.id, kind: '1', author: root.pubkey }, '/file');
    const targets = [
      await peerSigner.signEvent({ kind: 1, created_at: 11, content: '/file', tags: [['e', root.id, '', 'root'], ['p', bot.pubkey]] }),
      await peerSigner.signEvent({ ...reply, content: '/file@nostr:' + npubEncode(bot.pubkey) }),
    ];
    for (const target of targets) {
      assert.equal(await bot.receive(target, 'live', { relay: source }), true);
      await bot.idle();
      rejectPublic = true;
      const delayed = await bot.replyFile(anchors.get(target.kind)!, plain, options);
      assert.equal(delayed.status, 'pending');
      rejectPublic = false;
      const uploaded: number = uploads.length;
      await bot.flushOutbox();
      assert.equal(uploads.length, uploaded, 'retrying a public reply must not re-upload');
      const sent = delivery.filter(({ event }) => event.kind === 1111 && threadStructure(event).parent?.id === target.id);
      // Two identical replies may share an event ID at the same timestamp; capture both publication calls.
      assert.equal(sent.length, 2);
      for (const [index, { event, relays: destinations }] of sent.entries()) {
        assert.equal(threadStructure(event).root?.id, root.id);
        assert.equal(threadStructure(event).parent?.kind, String(target.kind));
        // Only the active handler has trusted source relay context; delayed
        // calls use configured write relays, including when the outbox retries.
        assert.deepEqual(new Set(destinations.map(url => new URL(url).origin)), new Set(index === 0 ? [write, source] : [write]));
        assert.equal(event.content, origin + '/' + hash(plain) + '.bin');
        assert.deepEqual(event.tags.find(t => t[0] === 'imeta'),
          ['imeta', 'url ' + event.content, 'm image/png', 'x ' + hash(plain), 'size ' + plain.length]);
        assert.ok(!JSON.stringify(event).includes('decryption-key'));
        assert.ok(verifyEvent(event));
      }
    }
    assert.equal(uploads.length, 6);
    for (const upload of uploads.slice(2)) assert.deepEqual(upload, { bytes: plain, type: 'image/png' });

    const missing = await peerSigner.signEvent({ kind: 1, created_at: 12, content: '/file', tags: [['e', 'a'.repeat(64), '', 'root']] });
    await assert.rejects(bot.replyFile(missing, plain), /Missing public thread root/);
    await assert.rejects(bot.replyFile({ ...root, content: 'tampered' }, plain), /valid signed/);
    await assert.rejects(bot.replyFile({ ...dm, content: 'tampered' }, plain), /authenticated incoming/);
    assert.equal(uploads.length, 6, 'invalid anchors must fail before uploading');
  } finally {
    await Promise.all([bot.close(), peer.close()]);
    await Promise.all([signer.close(), peerSigner.close()]);
    wire.close();
    peerWire.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Blossom descriptors must name the blob and use the selected origin or an explicitly trusted CDN', async () => {
  const bytes = Buffer.from('synthetic descriptor fixture'), sha256 = hash(bytes);
  let url = '';
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain fixture upload */ }
    res.writeHead(201).end(JSON.stringify({ url, sha256, size: bytes.length }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = new MemoryRelay().transport(), signer = nsecSigner(generateSecretKey());
  const options = { signer, transport, relays, database: ':memory:', keySync: false as const, blossomServers: [origin] };
  const bot = new Bot(options);
  const trusted = new Bot({ ...options, blossomDownloadOrigins: ['https://cdn.example.invalid/'] });
  try {
    await bot.start();
    for (const invalid of [
      `https://cdn.example.invalid/${sha256}.bin`,
      `http://localhost:${address.port}/${sha256}.bin`,
      `${origin}/${sha256}/arbitrary.bin`,
      `${origin}/${sha256}.bin?token=synthetic`,
    ]) {
      url = invalid;
      await assert.rejects(bot.uploadFile(bytes), /No configured Blossom server accepted/);
    }
    url = `${origin}/media/${sha256}.bin`;
    assert.equal((await bot.uploadFile(bytes)).url, url);
    await trusted.start();
    url = `https://cdn.example.invalid/storage/${sha256}.jpg`;
    assert.equal((await trusted.uploadFile(bytes)).url, url);
  } finally {
    await Promise.all([bot.close(), trusted.close()]);
    await signer.close();
    transport.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
