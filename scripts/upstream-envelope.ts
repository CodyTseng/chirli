/** MIT PsstPsst compatibility harness; execute only extracted software-key envelope functions. */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Event, EventTemplate } from "nostr-tools";
import type { Rumor } from "../src/protocol.js";
interface UpstreamFunctions {
	createGiftWrappedMessage(options: {
		rumorTemplate: EventTemplate;
		senderIdentityPubkey: string;
		senderEncPrivkey: Uint8Array;
		senderEncPubkey: string;
		recipientIdentityPubkey: string;
		recipientEncPubkey: string;
		signSeal(template: EventTemplate): Promise<Event>;
	}): Promise<{ rumor: Rumor; seal: Event; giftWrap: Event }>;
	unwrapGiftWrap(
		event: Event,
		secret: Uint8Array,
	): Promise<{
		rumor: Rumor;
		seal: Event;
		senderEncryptionPubkey: string;
	} | null>;
}
export async function upstreamEnvelope(path: string) {
	const source = await readFile(path, "utf8");
	const a = source.indexOf("const DM_TIME_RANDOMIZATION_SECONDS"),
		b = source.indexOf("// The sender's own copy"),
		c = source.indexOf("export async function unwrapGiftWrap("),
		d = source.indexOf("/** The vault selects");
	if (a < 0 || b <= a || c < 0 || d <= c)
		throw new Error("Unsupported upstream envelope source layout");
	const temporary = new URL(
		`../.interop-upstream-${randomUUID()}.ts`,
		import.meta.url,
	);
	await writeFile(
		temporary,
		`import {finalizeEvent,generateSecretKey,getEventHash,nip44,verifyEvent,validateEvent} from 'nostr-tools';
const KIND_SEAL=13,KIND_GIFT_WRAP=1059,SEAL_ENCRYPTION_PUBKEY_TAG='n';
const getConversationKeyAsync=async(secret,peer)=>nip44.v2.utils.getConversationKey(secret,peer);
const profileAsync=async(_profile,_label,run)=>run();
const profileSync=(_profile,_label,run)=>run();
${source.slice(a, b)}
${source.slice(c, d)}\n`,
		{ flag: "wx" },
	);
	try {
		const functions = (await import(temporary.href)) as UpstreamFunctions;
		return {
			functions,
			sha256: createHash("sha256").update(source).digest("hex"),
		};
	} finally {
		await unlink(temporary);
	}
}
