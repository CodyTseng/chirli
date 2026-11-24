import { z } from "zod";
import type { CommandArgument, CommandArgumentType } from "./nipcd.js";

/** Positional NIP-CD schemas deliberately accept a small, predictable Zod subset. */
export function commandArguments(schema: z.ZodObject): CommandArgument[] {
	const fail = (name: string, reason: string): never => {
		throw new TypeError(
			`Unsupported command args schema at ${name}: ${reason}`,
		);
	};
	const check = (field: z.ZodType, name: string) => {
		const def = field._zod.def as {
			coerce?: boolean;
			checks?: { _zod: { def: { check: string } } }[];
		};
		if (
			def.coerce ||
			def.checks?.some((item) => item._zod.def.check === "overwrite")
		)
			fail(name, "coercions and overwrites/transforms are not supported");
	};
	if (!(schema instanceof z.ZodObject))
		fail("args", "expected a Zod 4 z.object");
	check(schema, "args");
	const catchall = schema._zod.def.catchall;
	if (catchall && catchall._zod.def.type !== "never")
		fail("args", "catchall/loose objects cannot declare positional arguments");
	return Object.entries(schema.shape).map(([name, outer]) => {
		if (name === "__proto__") fail(name, "reserved top-level argument name");
		let field = outer as z.ZodType,
			required = true;
		check(field, name);
		const meta = field.meta() ?? {};
		if (field instanceof z.ZodOptional) {
			required = false;
			field = field.unwrap() as z.ZodType;
		}
		const metadata = { ...field.meta(), ...meta };
		check(field, name);
		const type = field._zod.def.type;
		const inferred: CommandArgumentType | undefined =
			type === "string"
				? "word"
				: type === "bigint"
					? "number"
					: type === "boolean"
						? "bool"
						: type === "enum"
							? "enum"
							: undefined;
		const explicit = metadata.nipcdType;
		if (
			explicit !== undefined &&
			![
				"word",
				"text",
				"pubkey",
				"event",
				"relay",
				"address",
				"number",
				"bool",
				"enum",
			].includes(explicit as string)
		)
			fail(name, "unknown nipcdType metadata");
		const wire = (explicit ?? inferred) as CommandArgumentType;
		if (wire === "address") {
			if (!(field instanceof z.ZodObject))
				fail(name, "address requires an object matching CommandAddress");
			const shape = (field as z.ZodObject).shape;
			if (
				Object.keys(shape).sort().join(",") !== "identifier,kind,pubkey,relays"
			)
				fail(name, "address needs kind, pubkey, identifier and relays");
			for (const [key, child] of Object.entries(shape)) {
				const value = child as z.ZodType;
				check(value, `${name}.${key}`);
				const expected =
					key === "kind" ? "number" : key === "relays" ? "array" : "string";
				if (value._zod.def.type !== expected)
					fail(name, `invalid address ${key} schema`);
				if (key === "relays") {
					const element = (value as z.ZodArray<z.ZodType>).element;
					check(element, `${name}.relays`);
					if (element._zod.def.type !== "string")
						fail(name, "address relays must be strings");
				}
			}
			check(field, name);
			if (
				(field as z.ZodObject)._zod.def.catchall &&
				(field as z.ZodObject)._zod.def.catchall?._zod.def.type !== "never"
			)
				fail(name, "address catchall is unsupported");
		} else if (
			!inferred ||
			!(
				wire === inferred ||
				(inferred === "word" &&
					["text", "pubkey", "event", "relay"].includes(wire))
			)
		)
			fail(
				name,
				"use string, bigint, boolean, string enum, optional(), or an explicitly annotated address object",
			);
		if (metadata.label !== undefined && typeof metadata.label !== "string")
			fail(name, "label metadata must be a string");
		const argument: CommandArgument = {
			name,
			type: wire,
			required,
			label: (metadata.label as string | undefined) ?? name,
		};
		if (wire === "enum") {
			const choices = Object.values((field as z.ZodEnum)._zod.def.entries);
			if (!choices.every((value) => typeof value === "string"))
				fail(name, "only string enum choices are supported");
			argument.choices = choices as string[];
		}
		return argument;
	});
}
