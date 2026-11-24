import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nsecEncode, npubEncode } from "nostr-tools/nip19";
import { Bot, generateSecretKey, getPublicKey } from "chirli";
import { runLive } from "../examples/live/runtime.js";
import { readyBanner } from "../examples/live/ready.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

for (const outcome of ["ready", "failed", "canceled", "retry-drain"] as const) {
	test(`live identity is withheld until startup completes (${outcome})`, {
		timeout: 3000,
	}, async (ctx) => {
		const directory = await mkdtemp(join(tmpdir(), "chirli-ready-"));
		const secret = generateSecretKey(),
			pubkey = getPublicKey(secret);
		const originalEnv = process.env,
			originalExitCode = process.exitCode;
		const publishing = deferred(),
			publish = deferred(),
			subscribing = deferred(),
			subscribe = deferred();
		const retryEntered = deferred(),
			releaseRetry = deferred();
		if (outcome === "retry-drain")
			ctx.mock.timers.enable({ apis: ["setInterval"] });
		const logs: string[] = [];
		let stopped = 0,
			closed = 0,
			outboxFlushes = 0;
		process.env = {
			CHIRLI_NSEC: nsecEncode(secret),
			CHIRLI_DATABASE: join(directory, "bot.sqlite"),
			CHIRLI_OUTBOX_RETRY_MS: "1000",
		};
		ctx.mock.method(console, "log", (...values: unknown[]) => {
			logs.push(values.join(" "));
		});
		ctx.mock.method(console, "error", () => {});
		ctx.mock.getter(Bot.prototype, "pubkey", () => pubkey);
		ctx.mock.method(Bot.prototype, "start", async () => {
			publishing.resolve();
			await publish.promise;
			if (outcome === "canceled") return;
			subscribing.resolve();
			await subscribe.promise;
			if (outcome === "failed") throw new Error("Subscription unavailable");
		});
		ctx.mock.method(Bot.prototype, "flushAnnouncements", async () => {
			retryEntered.resolve();
			await releaseRetry.promise;
		});
		ctx.mock.method(Bot.prototype, "flushOutbox", async () => {
			outboxFlushes++;
		});
		ctx.mock.method(Bot.prototype, "stop", async () => {
			stopped++;
		});
		ctx.mock.method(Bot.prototype, "close", async () => {
			closed++;
		});
		const running = runLive("commands", "Send /ping.", () => {});
		try {
			await publishing.promise;
			assert.equal(
				logs.length,
				0,
				"no identity or ready information during metadata publication",
			);
			if (outcome === "canceled") process.emit("SIGTERM");
			publish.resolve();
			if (outcome !== "canceled") {
				await subscribing.promise;
				assert.deepEqual(logs, [], "no identity before subscription readiness");
				subscribe.resolve();
			}
			if (outcome === "ready" || outcome === "retry-drain") {
				for (let i = 0; i < 100 && !logs.length; i++) await Promise.resolve();
				assert.equal(
					logs.length,
					1,
					"the complete ready banner is written once",
				);
				assert.match(logs[0], /Chirli commands ready/);
				assert.ok(logs[0].includes(`Bot npub: ${npubEncode(pubkey)}`));
				assert.ok(logs[0].includes(`Bot identity: ${pubkey}`));
				if (outcome === "retry-drain") {
					ctx.mock.timers.tick(1000);
					await retryEntered.promise;
				}
				process.emit("SIGTERM");
				if (outcome === "retry-drain") {
					for (let i = 0; i < 20; i++) await Promise.resolve();
					assert.equal(
						closed,
						0,
						"Client stays open until application retry work settles",
					);
					releaseRetry.resolve();
				}
			}
			await running;
			if (outcome === "failed" || outcome === "canceled")
				assert.equal(logs.length, 0);
			assert.equal(
				outboxFlushes,
				0,
				"shutdown does not begin a later outbox flush",
			);
			assert.equal(closed, 1);
			if (outcome !== "failed") assert.equal(stopped, 1);
		} finally {
			publish.resolve();
			subscribe.resolve();
			releaseRetry.resolve();
			process.emit("SIGTERM");
			await running;
			process.env = originalEnv;
			process.exitCode = originalExitCode;
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("ready banner displays the public identity as plain text", () => {
	const pubkey = getPublicKey(generateSecretKey());
	const npub = npubEncode(pubkey);
	const banner = readyBanner({
		name: "commands",
		hint: "Send /ping.",
		pubkey,
		mode: "nip17",
		relays: 1,
		storageEncrypted: false,
	});
	assert.ok(banner.includes(`Bot npub: ${npub}`));
	assert.ok(banner.includes(`Bot identity: ${pubkey}`));
	assert.ok(banner.includes(`Nostr address: nostr:${npub}`));
	assert.ok(!banner.includes("\x1b["));
});
