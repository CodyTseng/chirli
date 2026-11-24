import { z } from "zod";
import {
	localIdentity,
	localNip17Identity,
	rumor,
	standardEnvelope,
	wrap,
} from "../src/protocol.js";
import { Client } from "./client.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEvent, type Event, type Filter } from "nostr-tools";
import {
	naddrEncode,
	neventEncode,
	noteEncode,
	nprofileEncode,
	npubEncode,
} from "nostr-tools/nip19";
import {
	commandAddress,
	decodeCommandDefinition,
	encodeCommandDefinition,
	encodeCommandRevocation,
	generateSecretKey,
	matchesCommandScopes,
	parseCommand,
	selectCommandDefinitions,
	validateCommandDefinition,
	type CommandArgumentType,
	type CommandDefinition,
	type CommandEvent,
	type Transport,
} from "../src/index.js";
import { BotHandlers as Bot } from "../src/bot-handlers.js";
import { testRelay } from "./relay.js";
const executor = localIdentity(),
	sender = localIdentity(),
	outsider = localIdentity();
const base: CommandDefinition = {
	id: "stable:echo",
	command: "echo",
	title: "Echo",
	description: "Echo explicitly supplied text.",
	scopes: ["kind:14"],
};
const event = (content: string): CommandEvent => ({
	kind: 14,
	pubkey: sender.pubkey,
	tags: [["p", executor.pubkey]],
	content,
});
const context = { executor: executor.pubkey };
function parsed(definition: CommandDefinition, content: string) {
	const result = parseCommand(definition, event(content), context);
	assert.equal(result.status, "matched");
	if (result.status !== "matched") throw new Error("not matched");
	return result.invocation;
}
async function until(check: () => boolean) {
	for (let i = 0; i < 150; i++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("condition timeout");
}

test("NIP-CD encodes one addressable definition per stable d, not a 10992 bot manifest", async () => {
	const definition: CommandDefinition = {
		...base,
		args: [
			{ name: "who", type: "pubkey", required: true, label: "Recipient" },
			{ name: "why", type: "text", required: false, label: "Reason" },
		],
		scopes: ["kind:14", `author:${sender.pubkey}`],
	};
	const template = encodeCommandDefinition(definition, 10);
	assert.equal(template.kind, 31992);
	assert.deepEqual(template.tags, [
		["d", "stable:echo"],
		["command", "echo"],
		["title", "Echo"],
		["description", definition.description],
		["arg", "who", "pubkey", "required", "Recipient"],
		["arg", "why", "text", "optional", "Reason"],
		["s", "kind:14"],
		["s", `author:${sender.pubkey}`],
	]);
	const signed = await executor.sign(template),
		decoded = decodeCommandDefinition(signed);
	assert.ok(decoded);
	assert.deepEqual(decoded.definition, validateCommandDefinition(definition));
	assert.equal(decoded.address, commandAddress(executor.pubkey, definition.id));
	const updated = await executor.sign(
		encodeCommandDefinition({ ...definition, command: "renamed" }, 11),
	);
	assert.equal(decodeCommandDefinition(updated)?.address, decoded.address);
	assert.equal(
		decodeCommandDefinition({ ...signed, sig: "0".repeat(128) }),
		undefined,
	);
	const installed = await executor.sign({
		kind: 10992,
		created_at: 10,
		tags: [["a", decoded.address]],
		content: "",
	});
	assert.equal(decodeCommandDefinition(installed), undefined);
	assert.equal(encodeCommandDefinition({ ...base, id: "" }, 10).tags[0][1], "");
});
test("definition validation rejects ambiguous arguments and unknown constraints", () => {
	const arg = { name: "x", type: "word" as const, required: true, label: "X" };
	for (const definition of [
		{ ...base, id: undefined },
		{ ...base, command: "/echo" },
		{ ...base, command: "bad trigger" },
		{ ...base, title: "" },
		{ ...base, args: [arg, arg] },
		{
			...base,
			args: [
				{ ...arg, required: false },
				{ ...arg, name: "y" },
			],
		},
		{
			...base,
			args: [
				{ ...arg, required: false },
				{ ...arg, name: "y", required: false },
			],
		},
		{
			...base,
			args: [
				{ ...arg, type: "text" },
				{ ...arg, name: "y" },
			],
		},
		{ ...base, args: [{ ...arg, type: "enum", choices: [] }] },
		{ ...base, args: [{ ...arg, choices: ["not-an-enum"] }] },
		{ ...base, args: [{ ...arg, type: "enum", choices: null }] },
		{ ...base, scopes: ["future:unrestricted"] },
		{ ...base, scopes: ["kind:-1"] },
	])
		assert.throws(() =>
			validateCommandDefinition(definition as CommandDefinition),
		);
});
test("null choices are omitted for non-enum arguments", () => {
	const arg = { name: "x", type: "word" as const, required: true, label: "X" };
	const input = { ...base, args: [{ ...arg, choices: null }] };
	assert.deepEqual(
		Reflect.apply(validateCommandDefinition, undefined, [input]),
		validateCommandDefinition({ ...base, args: [arg] }),
	);
	assert.deepEqual(
		Reflect.apply(encodeCommandDefinition, undefined, [input, 10]),
		encodeCommandDefinition({ ...base, args: [arg] }, 10),
	);
});
test("argument parsing covers all draft types, bare/prefixed NIP-19 and precise integers", () => {
	const id = "a1".repeat(32),
		address = {
			kind: 30023,
			pubkey: sender.pubkey,
			identifier: "entry:one",
			relays: ["wss://hint.invalid"],
		};
	const cases: [CommandArgumentType, string, unknown][] = [
		["pubkey", sender.pubkey, sender.pubkey],
		["pubkey", sender.pubkey.toUpperCase(), sender.pubkey],
		["pubkey", npubEncode(sender.pubkey), sender.pubkey],
		[
			"pubkey",
			nprofileEncode({ pubkey: sender.pubkey, relays: [] }),
			sender.pubkey,
		],
		["event", id, id],
		["event", noteEncode(id), id],
		["event", neventEncode({ id, relays: [] }), id],
		["address", naddrEncode(address), address],
		["relay", "wss://relay.invalid/path", "wss://relay.invalid/path"],
		["number", "900719925474099312345", 900719925474099312345n],
		["bool", "yes", true],
		["bool", "0", false],
		["enum", "blue", "blue"],
		["word", "hello", "hello"],
	];
	for (const [type, raw, value] of cases) {
		const definition = {
			...base,
			args: [
				{
					name: "value",
					type,
					required: true,
					label: "Value",
					...(type === "enum" ? { choices: ["red", "blue"] } : {}),
				},
			],
		};
		for (const prefix of ["", "nostr:"])
			assert.deepEqual(
				parsed(definition, `/echo ${prefix}${raw}`).args.value,
				value,
			);
	}
	const literalChoice = {
		...base,
		args: [
			{
				name: "value",
				type: "enum" as const,
				required: true,
				label: "",
				choices: ["nostr:literal"],
			},
		],
	};
	for (const raw of ["nostr:literal", "nostr:nostr:literal"])
		assert.equal(
			parsed(literalChoice, `/echo ${raw}`).args.value,
			"nostr:literal",
		);
	for (const token of [
		"true",
		"yes",
		"1",
		"t",
		"y",
		"false",
		"no",
		"0",
		"f",
		"n",
	])
		assert.equal(
			typeof parsed(
				{
					...base,
					args: [{ name: "v", type: "bool", required: true, label: "" }],
				},
				`/echo ${token}`,
			).args.v,
			"boolean",
		);
	for (const [type, raw] of [
		["number", "-1"],
		["number", "1.2"],
		["number", "1e2"],
		["bool", "maybe"],
		["enum", "green"],
		["pubkey", noteEncode(id)],
		["address", `30023:${sender.pubkey}:entry`],
		["relay", "https://relay.invalid"],
	] as const) {
		assert.equal(
			parseCommand(
				{
					...base,
					args: [
						{
							name: "v",
							type,
							required: true,
							label: "",
							...(type === "enum" ? { choices: ["blue"] } : {}),
						},
					],
				},
				event(`/echo ${raw}`),
				context,
			).status,
			"invalid",
		);
	}
});
test("invocations require index zero, valid qualifiers, exact triggers and verbatim terminal text", () => {
	const definition: CommandDefinition = {
		...base,
		args: [
			{ name: "amount", type: "number", required: true, label: "Count" },
			{ name: "body", type: "text", required: false, label: "Body" },
		],
	};
	assert.equal(
		parseCommand(definition, event(" /echo 1 hello"), context).status,
		"not-matched",
	);
	assert.equal(
		parseCommand(definition, event("prefix /echo 1 hello"), context).status,
		"not-matched",
	);
	assert.equal(
		parseCommand(definition, event("/echoes 1 hello"), context).status,
		"not-matched",
	);
	assert.equal(
		parseCommand(
			definition,
			event(`/echo@${npubEncode(outsider.pubkey)} 1 hello`),
			context,
		).status,
		"not-matched",
	);
	for (const prefix of ["", "nostr:"])
		assert.equal(
			parsed(
				definition,
				`/echo@${prefix}${npubEncode(executor.pubkey)} 1 hello`,
			).args.body,
			"hello",
		);
	assert.equal(
		parseCommand(definition, event("/echo@npub1bad 1"), context).status,
		"invalid",
	);
	const result = parsed(definition, "/echo 2   keep\n  all whitespace  ");
	assert.equal(result.args.amount, 2n);
	assert.equal(result.args.body, "  keep\n  all whitespace  ");
	assert.equal(result.rawArgs.body, result.args.body);
	assert.equal(parsed(definition, "/echo 2").args.body, undefined);
	assert.equal(
		parsed(
			{
				...base,
				args: [{ name: "body", type: "text", required: true, label: "" }],
			},
			"/echo nostr:literal\ntext",
		).args.body,
		"nostr:literal\ntext",
	);
	const safe = parsed(
		{
			...base,
			args: [{ name: "__proto__", type: "word", required: true, label: "" }],
		},
		"/echo safe",
	);
	assert.equal(Object.getPrototypeOf(safe.args), null);
	assert.equal(
		Object.getOwnPropertyDescriptor(safe.args, "__proto__")?.value,
		"safe",
	);
	assert.equal(
		parseCommand({ ...base, args: [] }, event("/echo unwanted"), context)
			.status,
		"invalid",
	);
});
test("scope alternatives are grouped correctly; unknown relay provenance fails closed", () => {
	const scopes = [
		"kind:9",
		"kind:14",
		`author:${sender.pubkey}`,
		`author:${executor.pubkey}`,
		"tag:h:one",
		"tag:h:two",
		"tag:x",
		"relay:wss://relay.invalid",
	];
	const scoped = {
		...event("/echo"),
		tags: [
			["h", "two"],
			["x", "present"],
		],
	};
	assert.equal(
		matchesCommandScopes(scopes, scoped, { relay: "wss://relay.invalid/" }),
		true,
	);
	assert.equal(matchesCommandScopes(scopes, scoped), false);
	assert.equal(
		matchesCommandScopes(
			scopes,
			{ ...scoped, pubkey: outsider.pubkey },
			{ relay: "wss://relay.invalid" },
		),
		false,
	);
	assert.equal(
		matchesCommandScopes(
			scopes,
			{
				...scoped,
				tags: [
					["h", "two"],
					["x", ""],
				],
			},
			{ relay: "wss://relay.invalid" },
		),
		false,
	);
	assert.equal(
		matchesCommandScopes(["tag:x:"], { ...scoped, tags: [["x", ""]] }),
		true,
	);
	assert.equal(matchesCommandScopes([], scoped), true);
	assert.throws(() => matchesCommandScopes(["unknown:allow"], scoped));
});
test("discovery selects updates/ties before applying same-author revocations; no stale fallback", async () => {
	const old = await executor.sign(encodeCommandDefinition(base, 10)),
		newer = await executor.sign(
			encodeCommandDefinition({ ...base, command: "say" }, 11),
		);
	assert.equal(
		selectCommandDefinitions([newer, old], [executor.pubkey]).commands[0]
			.definition.command,
		"say",
	);
	const tieA = await executor.sign(
			encodeCommandDefinition({ ...base, title: "A" }, 12),
		),
		tieB = await executor.sign(
			encodeCommandDefinition({ ...base, title: "B" }, 12),
		);
	assert.equal(
		selectCommandDefinitions([tieA, tieB], [executor.pubkey]).commands[0].event
			.id,
		[tieA.id, tieB.id].sort()[0],
	);
	const malformed = await executor.sign({
		...encodeCommandDefinition(base, 13),
		tags: encodeCommandDefinition(base, 13).tags.filter(
			(tag) => tag[0] !== "command",
		),
	});
	const invalid = selectCommandDefinitions(
		[old, newer, malformed],
		[executor.pubkey],
	);
	assert.equal(invalid.commands.length, 0);
	assert.equal(invalid.retired[0].reason, "invalid-definition");
	const deletion = await executor.sign(
		encodeCommandRevocation(executor.pubkey, base.id, 12),
	);
	assert.equal(
		selectCommandDefinitions([old, newer, deletion], [executor.pubkey]).commands
			.length,
		0,
	);
	assert.equal(
		selectCommandDefinitions([deletion], [executor.pubkey]).retired[0].address,
		commandAddress(executor.pubkey, base.id),
	);
	const unauthorized = await outsider.sign(
		encodeCommandRevocation(executor.pubkey, base.id, 99),
	);
	assert.equal(
		selectCommandDefinitions(
			[newer, unauthorized],
			[executor.pubkey, outsider.pubkey],
		).commands.length,
		1,
	);
	const republished = await executor.sign(encodeCommandDefinition(base, 13));
	assert.equal(
		selectCommandDefinitions([republished, deletion], [executor.pubkey])
			.commands.length,
		1,
	);
	const byId = await executor.sign({
		kind: 5,
		created_at: 14,
		tags: [
			["e", republished.id],
			["k", "31992"],
		],
		content: "",
	});
	assert.equal(
		selectCommandDefinitions([old, republished, byId], [executor.pubkey])
			.commands.length,
		0,
	);
	const installed = await executor.sign({
		kind: 10992,
		created_at: 99,
		tags: [["a", commandAddress(executor.pubkey, base.id)]],
		content: "",
	});
	assert.equal(
		selectCommandDefinitions([newer, installed], [executor.pubkey]).commands
			.length,
		1,
	);
	assert.equal(
		selectCommandDefinitions(
			[{ ...newer, sig: "0".repeat(128) }, old],
			[executor.pubkey],
		).commands[0].event.id,
		old.id,
	);
});
for (const mode of ["nip4e", "nip17"] as const) {
	test(`${mode}: public declarations synchronize before execution with verified DM scope/context`, async () => {
		const relay = await testRelay(),
			make = mode === "nip17" ? localNip17Identity : localIdentity,
			a = make(),
			b = make(),
			c = make();
		const create = (identity: typeof a) =>
			new Client({
				mode,
				identity,
				relays: [relay.url],
				database: ":memory:",
				storageKey: generateSecretKey(),
			});
		const user = create(a),
			service = create(b),
			stranger = create(c),
			replies: string[] = [];
		let bot = new Bot(service);
		let commands = 0,
			fallback = 0,
			denied = 0;
		const definition = {
			...base,
			args: [
				{ name: "count", type: "number", required: true, label: "Count" },
				{ name: "body", type: "text", required: false, label: "Body" },
			],
			scopes: ["kind:14", `relay:${relay.url}`],
		} as const satisfies CommandDefinition;
		bot.command(
			{
				...(({ id, ...local }) => local)(definition),
				args: z.object({
					count: z.bigint().meta({ label: "Count" }),
					body: z
						.string()
						.optional()
						.meta({ label: "Body", nipcdType: "text" }),
				}),
			},
			async (ctx, { count, body }) => {
				commands++;
				assert.equal(ctx.input.sender, a.pubkey);
				assert.equal(ctx.input.event.kind, 14);
				assert.equal(service.getMessage(ctx.input.id)?.relay, relay.url);
				await ctx.reply(`${count}: ${body}`);
			},
			{
				authorize: (ctx) => {
					if (ctx.sender !== a.pubkey) {
						denied++;
						return false;
					}
					return true;
				},
			},
		);
		bot.command(
			{
				scopes: ["kind:14"],
				...(({ id, ...local }) => local)(base),
				args: z.object({
					text: z
						.string()
						.optional()
						.meta({ label: "Text", nipcdType: "text" }),
				}),
				command: "private",
				description: "Never automatically publish this private command.",
			},
			() => {},
			{},
		);
		bot.command(
			{
				command: "legacy",
				title: "legacy",
				description: "Run /legacy in a private message.",
				scopes: ["kind:14"],
				args: z.object({
					text: z
						.string()
						.optional()
						.meta({ label: "Text", nipcdType: "text" }),
				}),
			},
			async (ctx) => {
				await ctx.reply("legacy works");
			},
			{},
		);
		bot.handle(() => {
			fallback++;
		});
		user.handle((message) => {
			replies.push(message.text);
		});
		try {
			const copy = bot.getCommandDefinitions();
			copy[0].command = "mutated";
			assert.equal(bot.getCommandDefinitions()[0].command, "echo");
			await user.announce();
			await service.announce();
			await stranger.announce();
			const oldRumor = rumor(
				a.pubkey,
				b.pubkey,
				"/echo 1 old",
				Date.now() - 1000,
			);
			const oldWrap = await wrap(
				oldRumor,
				a,
				b.pubkey,
				b.pubkey,
				standardEnvelope,
			);
			relay.events.set(oldWrap.id, oldWrap);
			await bot.start();
			await service.idle();
			await user.start();
			assert.equal(commands, 0);
			assert.equal(service.getMessage(oldRumor.id), undefined);
			assert.equal(
				await service.receive(oldWrap, "live", { relay: relay.url }),
				false,
			);
			assert.equal(
				[...relay.events.values()].some((event) => event.kind === 31992),
				true,
			);
			await user.send(b.pubkey, "/echo 2 hello\n  world");
			await until(() => replies.length === 1);
			assert.equal(replies[0], "2: hello\n  world");
			await stranger.send(b.pubkey, "/echo 3 denied");
			await until(() => denied === 1);
			await service.idle();
			assert.equal(commands, 1);
			assert.equal(fallback, 0);
			await user.send(b.pubkey, "/echo invalid ordinary");
			await service.idle();
			assert.equal(fallback, 0);
			await user.send(b.pubkey, "/legacy");
			await until(() => replies.length === 2);
			assert.equal(replies[1], "legacy works");
			const discovery = await user.discoverCommands({
				authors: [b.pubkey],
				relays: [relay.url],
			});
			assert.equal(discovery.commands.length, 3);
			const command = discovery.commands.find(
				(command) => command.definition.id === base.command,
			);
			assert.ok(command);
			const published = command.event;
			assert.ok(verifyEvent(published));
			assert.equal(published.pubkey, b.pubkey);
			assert.equal(await service.receive(published, "live"), false);
			assert.equal(discovery.complete, false);
			assert.equal(discovery.coverage, "relay-snapshot");
			await service.stop();
			bot.dispose();
			bot = new Bot(service);
			bot.command(
				{
					...(({ id, ...local }) => local)(definition),
					args: z.object({
						count: z.bigint().meta({ label: "Count" }),
						body: z
							.string()
							.optional()
							.meta({ label: "Body", nipcdType: "text" }),
					}),
					title: "Updated",
				},
				() => {},
			);
			await bot.start();
			assert.equal(
				(
					await user.discoverCommands({
						authors: [b.pubkey],
						ids: [base.command],
						relays: [relay.url],
					})
				).commands[0].definition.title,
				"Updated",
			);
			await service.revokeCommand(base.command);
			assert.equal(
				(
					await user.discoverCommands({
						authors: [b.pubkey],
						ids: [base.command],
						relays: [relay.url],
					})
				).commands.length,
				0,
			);
			assert.equal(bot.getCommandDefinitions().length, 0);
			assert.equal(
				[...relay.events.values()].some((event) => event.kind === 10992),
				false,
			);
		} finally {
			await user.close();
			await stranger.close();
			await bot.client.close();
			bot.dispose();
			await relay.close();
		}
	});
}
test("metadata discovery requires explicit authors/relays and never consults DM key/install lists", async () => {
	const filters: Filter[] = [],
		published: Event[] = [];
	const transport: Transport = {
		query: async (_relays, filter) => {
			filters.push(filter);
			return [];
		},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
		publish: async (_relays, e) => {
			published.push(e);
		},
		close() {},
	};
	const client = new Client({
		mode: "nip4e",
		identity: localIdentity(),
		relays: ["ws://dm-only.invalid"],
		transport,
		database: ":memory:",
		storageKey: generateSecretKey(),
	});
	try {
		await assert.rejects(
			client.discoverCommands({ authors: [], relays: ["ws://index.invalid"] }),
		);
		await assert.rejects(
			client.discoverCommands({ authors: [executor.pubkey], relays: [] }),
		);
		assert.equal(filters.length, 0);
		assert.equal(published.length, 0);
		await client.discoverCommands({
			authors: [executor.pubkey],
			ids: [base.command],
			relays: ["ws://index.invalid"],
		});
		assert.deepEqual(
			filters.map((filter) => filter.kinds),
			[[31992], [5]],
		);
		assert.deepEqual(filters[0]["#d"], [base.command]);
		assert.equal(filters[1]["#d"], undefined);
	} finally {
		await client.close();
	}
});

test("unqualified syntax can match multiple executors while qualifiers select one without DM fan-out", () => {
	const invocation = event("/echo");
	assert.equal(
		parseCommand(base, invocation, { executor: executor.pubkey }).status,
		"matched",
	);
	assert.equal(
		parseCommand(base, invocation, { executor: outsider.pubkey }).status,
		"matched",
	);
	const targeted = event(`/echo@nostr:${npubEncode(executor.pubkey)}`);
	assert.equal(
		parseCommand(base, targeted, { executor: executor.pubkey }).status,
		"matched",
	);
	assert.equal(
		parseCommand(base, targeted, { executor: outsider.pubkey }).status,
		"not-matched",
	);
});

test("a configured DM relay is not proof of invocation provenance; duplicate intake cannot bypass a relay scope", async () => {
	const sender = localIdentity(),
		receiver = localIdentity(),
		url = "ws://configured.invalid";
	const transport: Transport = {
		query: async () => [],
		publish: async () => {},
		close() {},
		subscribe: () => ({ ready: Promise.resolve(), close() {} }),
	};
	const client = new Client({
		mode: "nip4e",
		identity: receiver,
		relays: [url],
		transport,
		database: ":memory:",
		storageKey: generateSecretKey(),
		recovery: false,
	});
	const bot = new Bot(client);
	let commands = 0,
		fallback = 0;
	bot.command(
		{
			...(({ id, ...local }) => local)(base),
			scopes: ["kind:14", `relay:${url}`],
			args: z.object({
				text: z.string().optional().meta({ label: "Text", nipcdType: "text" }),
			}),
		},
		() => {
			commands++;
		},
	);
	bot.handle(() => {
		fallback++;
	});
	const { getPublicKey } = await import("../src/index.js");
	try {
		await bot.start();
		const r = rumor(sender.pubkey, receiver.pubkey, "/echo");
		const unknown = await wrap(
			r,
			sender,
			receiver.pubkey,
			getPublicKey(receiver.encryptionKey),
		);
		await client.receive(unknown, "live");
		await client.idle();
		assert.equal(commands, 0);
		assert.equal(fallback, 1);
		const duplicate = await wrap(
			r,
			sender,
			receiver.pubkey,
			getPublicKey(receiver.encryptionKey),
		);
		assert.equal(
			await client.receive(duplicate, "live", { relay: url }),
			false,
		);
		await client.idle();
		assert.equal(commands, 0);
		const fresh = await wrap(
			rumor(sender.pubkey, receiver.pubkey, "/echo"),
			sender,
			receiver.pubkey,
			getPublicKey(receiver.encryptionKey),
		);
		await client.receive(fresh, "live", { relay: url });
		await client.idle();
		assert.equal(commands, 1);
	} finally {
		await bot.client.close();
		bot.dispose();
	}
});
