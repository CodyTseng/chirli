import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

test("tutorial command additions compile together with the actual live entrypoint without duplicate Zod imports", async () => {
	const root = fileURLToPath(new URL("../", import.meta.url)),
		tutorial = await readFile(join(root, "docs/TUTORIAL.md"), "utf8"),
		entry = await readFile(join(root, "examples/live/commands.ts"), "utf8");
	const section = tutorial.slice(
		tutorial.indexOf("## 2. Add a command"),
		tutorial.indexOf("## 3. Persist conversation state"),
	);
	const blocks = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map(
		(match) => match[1],
	);
	assert.equal(blocks.length, 4);
	const imports = blocks
			.filter((block) => block.trimStart().startsWith("import "))
			.join("\n"),
		handlers = blocks
			.filter((block) => !block.trimStart().startsWith("import "))
			.join("\n");
	const source =
			imports +
			"\n" +
			entry.replace(
				/(?:\(bot\)|\bbot)\s*=>\s*\{/,
				(opening) => `${opening}\n${handlers}\n`,
			),
		virtual = join(root, "examples/live/tutorial-composition.ts");
	assert.match(source, /command:\s*['"]roll['"]/);
	const config = ts.readConfigFile(
			join(root, "tsconfig.check.json"),
			ts.sys.readFile,
		),
		parsed = ts.parseJsonConfigFileContent(
			config.config,
			ts.sys,
			root,
			{ noEmit: true },
			join(root, "tsconfig.check.json"),
		),
		host = ts.createCompilerHost(parsed.options),
		getSource = host.getSourceFile;
	host.getSourceFile = (file, ...args) =>
		file === virtual
			? ts.createSourceFile(file, source, args[0], true)
			: getSource(file, ...args);
	const program = ts.createProgram([virtual], parsed.options, host),
		diagnostics = ts.getPreEmitDiagnostics(program);
	assert.deepEqual(
		diagnostics.map((d) =>
			ts.flattenDiagnosticMessageText(d.messageText, "\n"),
		),
		[],
	);
});
