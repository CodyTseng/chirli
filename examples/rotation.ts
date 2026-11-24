import assert from "node:assert/strict";
import { Bot, generateSecretKey, nsecSigner, type Transport } from "chirli";
import { MemoryRelay } from "./_support.js";
const serviceSigner = nsecSigner(generateSecretKey());
const freshSigner = nsecSigner(generateSecretKey());
const staleSigner = nsecSigner(generateSecretKey());

// Memory-only demonstration. Use a persistent database and storageKey in production.
const relay = new MemoryRelay(),
	relays = ["wss://demo.invalid"],
	wire = relay.transport();
const service = new Bot({
	mode: "nip4e",
	signer: serviceSigner,
	relays,
	transport: relay.transport(),
	database: ":memory:",
	storageKey: generateSecretKey(),
	keyRotation: { intervalMs: 30 * 24 * 60 * 60 * 1000, retainLegacyKeys: 5 },
});
const fresh = new Bot({
	signer: freshSigner,
	relays,
	transport: relay.transport(),
	database: ":memory:",
	storageKey: generateSecretKey(),
});
let stale: Bot | undefined;
try {
	await service.start();
	await fresh.start();
	const old = service.encryptionKeys().currentPublicKey;
	const oldClaims = await wire.query(relays, {
		kinds: [10044],
		authors: [service.pubkey],
	});
	// This peer's discovery view intentionally omits the newer key announcement.
	const staleTransport: Transport = {
		...wire,
		query: async (relays, filter) => {
			const events = await wire.query(relays, filter);
			return filter.authors?.includes(service.pubkey) &&
				filter.kinds?.includes(10044)
				? [...events.filter((event) => event.kind !== 10044), ...oldClaims]
				: events;
		},
	};
	stale = new Bot({
		mode: "nip4e",
		signer: staleSigner,
		relays,
		transport: staleTransport,
		database: ":memory:",
		storageKey: generateSecretKey(),
	});
	await stale.start();
	await service.rotateEncryptionKey();
	assert.notEqual(service.encryptionKeys().currentPublicKey, old);
	await stale.send(service.pubkey, "stale-cache message");
	await service.idle();
	assert.equal(
		service.dmHistory(stale.pubkey).messages[0].text,
		"stale-cache message",
	);
	await fresh.send(service.pubkey, "fresh-key message");
	await service.idle();
	assert.equal(
		service.dmHistory(fresh.pubkey).messages[0].text,
		"fresh-key message",
	);
	console.log("nip4e: rotated; previous key retained for delayed senders.");
	console.log("Default nip17 peer: fresh-key message decrypted.");
	console.log(
		"Memory only; use a persistent database to retain keys across restarts.",
	);
} finally {
	await stale?.close();
	await service.close();
	await fresh.close();
	wire.close();
	await serviceSigner.close();
	await freshSigner.close();
	await staleSigner.close();
}
