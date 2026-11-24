/** Extract the unchanged upstream software-key envelope functions for a compatibility fixture. */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { localIdentity, getPublicKey } from "../src/protocol.js";
const upstream = process.argv[2];
if (!upstream)
	throw new Error(
		"Pass the path to the PsstPsst src/services/crypto/nip17-gift-wrap.ts source file.",
	);
const source = await readFile(upstream, "utf8");
const slice = source.slice(
	source.indexOf("const DM_TIME_RANDOMIZATION_SECONDS"),
	source.indexOf("// The sender's own copy"),
);
const temp = new URL("../.fixture-upstream.ts", import.meta.url);
await writeFile(
	temp,
	`import {finalizeEvent,generateSecretKey,getEventHash,nip44} from 'nostr-tools';
const KIND_SEAL=13,KIND_GIFT_WRAP=1059,SEAL_ENCRYPTION_PUBKEY_TAG='n';
const getConversationKeyAsync=async (secret,peer)=>nip44.v2.utils.getConversationKey(secret,peer);
${slice}`,
);
try {
	const { createGiftWrappedMessage } = await import(temp.href);
	const a = localIdentity(),
		b = localIdentity();
	const result = await createGiftWrappedMessage({
		rumorTemplate: {
			kind: 14,
			content: "upstream split-key fixture",
			created_at: 1700000001,
			tags: [
				["p", b.pubkey],
				["ms", "123"],
			],
		},
		senderIdentityPubkey: a.pubkey,
		senderEncPrivkey: a.encryptionKey,
		senderEncPubkey: getPublicKey(a.encryptionKey),
		recipientIdentityPubkey: b.pubkey,
		recipientEncPubkey: getPublicKey(b.encryptionKey),
		signSeal: a.sign,
	});
	await writeFile(
		new URL("../test/fixtures/upstream.json", import.meta.url),
		`${JSON.stringify(
			{
				provenance: {
					path: "src/services/crypto/nip17-gift-wrap.ts",
					sha256: createHash("sha256").update(source).digest("hex"),
					note: "Generated using unchanged extracted upstream envelope functions, software keys only. All keys are disposable fixture keys.",
				},
				recipient: {
					pubkey: b.pubkey,
					encryptionSecret: Buffer.from(b.encryptionKey).toString("hex"),
				},
				...result,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	await unlink(temp);
}
