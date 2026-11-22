import { hexKey } from './protocol.js';

/** Synchronous policy over the authenticated identity only, never a mutable message or wrapper key. */
export type InboundPolicy = (sender: string) => boolean;

/** Snapshot an identity allowlist. Empty denies all external incoming senders. */
export function allowlist(pubkeys: readonly string[]): InboundPolicy {
  if (!Array.isArray(pubkeys) || !Array.from(pubkeys).every(hexKey)) {
    throw new TypeError('allowlist must be an array of lowercase hex identity public keys');
  }
  const identities = new Set(pubkeys);
  return sender => identities.has(sender);
}
