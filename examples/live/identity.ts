import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { decode, nsecEncode } from "nostr-tools/nip19";
import {
	generateSecretKey,
	getPublicKey,
	StorageEncryptionError,
} from "chirli";
import { ConfigurationError } from "./config.js";
interface SavedIdentity {
	version: 1;
	publicKey: string;
	encoding: "plain" | "aes-256-gcm";
	payload: string;
}
/** Application-owned local identity persistence; never prints secret material or replaces a file. */
export function generatedIdentity(
	database: string,
	storageKey?: Uint8Array,
): { nsec: string; publicKey: string; file: string; created: boolean } {
	const file = `${resolve(database)}.identity.json`;
	const load = () => {
		try {
			const saved = JSON.parse(readFileSync(file, "utf8")) as SavedIdentity;
			if (
				saved.version !== 1 ||
				!/^[0-9a-f]{64}$/.test(saved.publicKey) ||
				typeof saved.payload !== "string"
			)
				throw new Error();
			let nsec: string;
			if (saved.encoding === "plain") {
				if (storageKey)
					throw new StorageEncryptionError("STORAGE_MODE_MISMATCH");
				nsec = saved.payload;
			} else if (saved.encoding === "aes-256-gcm") {
				if (!storageKey)
					throw new StorageEncryptionError("STORAGE_KEY_REQUIRED");
				const data = Buffer.from(saved.payload, "base64"),
					cipher = createDecipheriv(
						"aes-256-gcm",
						storageKey,
						data.subarray(0, 12),
					);
				cipher.setAAD(
					Buffer.from(`chirli:generated-identity:v1:${saved.publicKey}`),
				);
				cipher.setAuthTag(data.subarray(12, 28));
				nsec = Buffer.concat([
					cipher.update(data.subarray(28)),
					cipher.final(),
				]).toString("utf8");
			} else throw new Error();
			const key = decode(nsec);
			if (key.type !== "nsec" || getPublicKey(key.data) !== saved.publicKey)
				throw new Error();
			return { nsec, publicKey: saved.publicKey, file, created: false };
		} catch (error) {
			if (error instanceof StorageEncryptionError) throw error;
			throw new ConfigurationError(
				"Saved generated identity cannot be read. Restore its file/original storage key; refusing to generate a replacement.",
			);
		}
	};
	if (existsSync(file)) return load();
	if (existsSync(database) && statSync(database).size > 0)
		throw new ConfigurationError(
			"Database already exists without a generated identity file. Supply its original CHIRLI_NSEC/CHIRLI_BUNKER or restore the identity file; refusing to change accounts.",
		);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const key = generateSecretKey(),
		publicKey = getPublicKey(key),
		nsec = nsecEncode(key);
	const saved: SavedIdentity = {
		version: 1,
		publicKey,
		encoding: storageKey ? "aes-256-gcm" : "plain",
		payload: nsec,
	};
	if (storageKey) {
		const iv = randomBytes(12),
			cipher = createCipheriv("aes-256-gcm", storageKey, iv);
		cipher.setAAD(Buffer.from(`chirli:generated-identity:v1:${publicKey}`));
		const encrypted = Buffer.concat([
			cipher.update(nsec, "utf8"),
			cipher.final(),
		]);
		saved.payload = Buffer.concat([
			iv,
			cipher.getAuthTag(),
			encrypted,
		]).toString("base64");
	}
	try {
		const descriptor = openSync(file, "wx", 0o600);
		try {
			writeFileSync(descriptor, `${JSON.stringify(saved)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		const directory = openSync(dirname(file), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return load();
		throw new ConfigurationError(
			"Cannot persist generated identity. Check directory/file permissions; no relay announcement was made.",
		);
	}
	return { nsec, publicKey, file, created: true };
}
