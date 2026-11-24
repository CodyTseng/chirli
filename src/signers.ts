import { getPublicKey } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import { hexKey, type Identity, type LocalIdentity } from "./protocol.js";
import { SignerError } from "./errors.js";
import type { Signer } from "./signer.js";
import { nsecSigner } from "./signers/nsec.js";
import { bunkerSigner } from "./signers/bunker.js";
export { nsecSigner, bunkerSigner };
export type { Signer } from "./signer.js";
export type { BunkerOptions } from "./signers/bunker.js";

/** Internal protocol capabilities resolved once from the account signer. */
export function identityFromSigner(
	signer: Signer,
	options: {
		mode?: "nip4e";
		encryptionKey: Uint8Array;
		oldEncryptionKeys?: Uint8Array[];
	},
): Promise<LocalIdentity>;

export function identityFromSigner(
	signer: Signer,
	options?: {
		mode?: "nip17" | "nip4e";
		encryptionKey?: Uint8Array;
		oldEncryptionKeys?: Uint8Array[];
	},
): Promise<Identity>;

export async function identityFromSigner(
	signer: Signer,
	options: {
		mode?: "nip4e" | "nip17";
		encryptionKey?: Uint8Array;
		oldEncryptionKeys?: Uint8Array[];
	} = {},
): Promise<Identity> {
	if (
		options.mode !== undefined &&
		options.mode !== "nip4e" &&
		options.mode !== "nip17"
	) {
		throw new TypeError("Invalid signer identity mode");
	}
	// Supplying a messaging key is the legacy explicit split-key form.
	const mode = options.mode ?? (options.encryptionKey ? "nip4e" : "nip17");
	if (mode === "nip17" && options.encryptionKey) {
		throw new TypeError(
			"nip17 signer identities do not accept split messaging keys",
		);
	}
	// Every supported DM profile needs identity-key NIP-44, even with split outgoing keys.
	for (const capability of [
		"getPublicKey",
		"signEvent",
		"nip44Encrypt",
		"nip44Decrypt",
	] as const) {
		if (typeof signer?.[capability] !== "function") {
			throw new TypeError(`Signer must implement ${capability}`);
		}
	}

	const pubkey = await signer.getPublicKey();
	if (!hexKey(pubkey)) {
		throw new SignerError("get_public_key validation");
	}
	const crypto = {
		publicKey: pubkey,
		asynchronous: true,
		encrypt: (text: string, peer: string) => signer.nip44Encrypt(peer, text),
		decrypt: (content: string, peer: string) =>
			signer.nip44Decrypt(peer, content),
	};
	const common = {
		pubkey,
		sign: (template: EventTemplate) => signer.signEvent(template),
		identityEncryption: crypto,
	};
	if (mode === "nip17") {
		return {
			...common,
			messaging: crypto,
			oldEncryptionKeys: options.oldEncryptionKeys,
		};
	}
	if (options.encryptionKey) {
		getPublicKey(options.encryptionKey);
	}
	return {
		...common,
		encryptionKey: options.encryptionKey,
		oldEncryptionKeys: options.oldEncryptionKeys,
	};
}
