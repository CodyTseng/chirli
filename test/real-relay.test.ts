import { localIdentity, localNip17Identity } from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey } from "../src/index.js";
const relayBinary = process.env.PSST_RELAY_BIN;
for (const mode of ["nip4e", "nip17"] as const) {
	test(`existing PsstPsst Go relay: NIP-42 authenticated ${mode} DM`, {
		skip: !relayBinary,
	}, async () => {
		assert.ok(relayBinary);
		const probe = createServer();
		await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
		const address = probe.address();
		assert.ok(address && typeof address === "object");
		const { port } = address;
		await new Promise<void>((r) => probe.close(() => r()));
		const dir = await mkdtemp(join(tmpdir(), "psst-go-")),
			url = `ws://127.0.0.1:${port}`;
		const proc = spawn(
			relayBinary,
			[
				"-listen",
				`127.0.0.1:${port}`,
				"-relay-url",
				url,
				"-db",
				join(dir, "relay.sqlite"),
			],
			{
				cwd: dir,
				env: {
					...process.env,
					APNS_KEY_FILE: "",
					APNS_KEY_ID: "",
					APNS_SANDBOX_KEY_FILE: "",
					APNS_SANDBOX_KEY_ID: "",
					APNS_TEAM_ID: "",
					APNS_TOPIC: "",
					APNS_SANDBOX_TOPIC: "",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Go relay startup timeout")),
				10000,
			);
			proc.stderr.on("data", (b) => {
				output += b.toString();
				if (output.includes("relay listening")) {
					clearTimeout(timer);
					resolve();
				}
			});
			proc.once("error", reject);
			proc.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Go relay exited ${code}`));
			});
		});
		const identity = mode === "nip17" ? localNip17Identity : localIdentity;
		const a = identity(),
			b = identity();
		const alice = new Client({
				mode,
				identity: a,
				relays: [url],
				database: ":memory:",
				storageKey: generateSecretKey(),
			}),
			bob = new Client({
				mode,
				identity: b,
				relays: [url],
				database: ":memory:",
				storageKey: generateSecretKey(),
			});
		try {
			await alice.announce();
			await bob.announce();
			let received = "";
			bob.handle((m) => {
				received = m.text;
			});
			await bob.start();
			const result = await alice.send(b.pubkey, "actual PsstPsst relay");
			assert.equal(result.status, "relay-accepted");
			for (let i = 0; i < 100 && !received; i++)
				await new Promise((r) => setTimeout(r, 20));
			assert.equal(received, "actual PsstPsst relay");
			await bob.idle();
			assert.equal(bob.history(a.pubkey).messages[0].id, result.id);
		} finally {
			await alice.close();
			await bob.close();
			proc.kill("SIGTERM");
			await new Promise<void>((r) => {
				if (proc.exitCode !== null) r();
				else proc.once("exit", () => r());
			});
			await rm(dir, { recursive: true, force: true });
		}
	});
}
