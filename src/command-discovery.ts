import type { Transport } from "./relay.js";
import { hexKey } from "./protocol.js";
import {
	commandRelayURL,
	selectCommandDefinitions,
	type DiscoverCommandsOptions,
} from "./nipcd.js";

function discoveryRelays(relays: string[]): string[] {
	if (!Array.isArray(relays) || !relays.length) {
		throw new TypeError("Explicit command metadata relays are required");
	}
	return [...new Set(relays.map(commandRelayURL))];
}

/** Read-only discovery never changes registrations or publishes account metadata. */
export async function discoverCommandCatalog(
	transport: Transport,
	options: DiscoverCommandsOptions,
) {
	if (
		!options.authors?.length ||
		!options.authors.every(hexKey) ||
		(options.ids !== undefined &&
			(!options.ids.length ||
				!options.ids.every((id) => typeof id === "string")))
	) {
		throw new TypeError("Explicit valid command authors/IDs are required");
	}
	const limit = options.limit ?? 200;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
		throw new TypeError("Command discovery limit must be in 1..1000");
	}
	const relays = discoveryRelays(options.relays),
		authors = [...new Set(options.authors)];
	const [definitions, deletions] = await Promise.all([
		transport.query(relays, {
			kinds: [31992],
			authors,
			...(options.ids ? { "#d": options.ids } : {}),
			limit,
		}),
		transport.query(relays, { kinds: [5], authors, limit }),
	]);
	return selectCommandDefinitions(
		[...definitions, ...deletions],
		authors,
		options.ids,
	);
}
