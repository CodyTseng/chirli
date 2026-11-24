import { spawnSync } from "node:child_process";
for (const name of [
	"commands",
	"history",
	"session",
	"ai-handler",
	"protocol-modes",
	"signers",
	"nipcd",
	"interop",
	"rotation",
	"storage",
	"allowlist",
	"key-sync",
	"public",
	"async-reply",
]) {
	console.log(`\nRunning example: ${name}`);
	const result = spawnSync(process.execPath, [`dist/examples/${name}.js`], {
		stdio: "inherit",
		timeout: 15_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`Example ${name} failed (${result.status ?? result.signal})`,
		);
}
console.log("\nAll 14 offline examples passed.");
