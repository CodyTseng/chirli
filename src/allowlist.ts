import type { Context, Next } from "./bot-handlers.js";
import { hexKey } from "./protocol.js";

/** Allow the selected verified account keys to continue through the middleware chain. */
export function allowlist(
	pubkeys: readonly string[],
): (ctx: Pick<Context, "sender">, next: Next) => Promise<void> | undefined {
	if (!Array.isArray(pubkeys) || !Array.from(pubkeys).every(hexKey)) {
		throw new TypeError(
			"allowlist must be an array of lowercase hex identity public keys",
		);
	}
	const identities = new Set(pubkeys);
	return (ctx, next) => (identities.has(ctx.sender) ? next() : undefined);
}
