import type { Event, EventTemplate } from "nostr-tools";

/** Account capabilities only: callers never inspect signer type or secret material. */
export interface Signer {
	getPublicKey(): Promise<string>;
	signEvent(template: EventTemplate): Promise<Event>;
	// DM encryption uses the account identity. Split messaging keys stay in SDK custody.
	nip44Encrypt(peer: string, plaintext: string): Promise<string>;
	nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
	/** Optional capability; Chirli messaging itself uses NIP-44. */
	nip04Encrypt?(peer: string, plaintext: string): Promise<string>;
	nip04Decrypt?(peer: string, ciphertext: string): Promise<string>;
	/** Release this signer instance without deleting application-owned credentials. */
	close?(): Promise<void>;
}
