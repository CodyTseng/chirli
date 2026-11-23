import { npubEncode } from 'nostr-tools/nip19';

/** Build the entire banner before writing so its readiness marker includes the identity. */
export function readyBanner(options: {
  name: string;
  hint: string;
  pubkey: string;
  mode: string;
  relays: number;
  allowlist?: readonly string[];
  storageEncrypted: boolean;
  savedIdentity?: string;
}): string {
  const { pubkey, mode } = options;
  const npub = npubEncode(pubkey);
  const uri = `nostr:${npub}`;
  const lines = [
    '',
    `Chirli ${options.name} ready (${mode}; ${options.relays} configured relay(s)).`,
    '',
    `Bot npub: ${npub}`,
    `Bot identity: ${pubkey}`,
    `Nostr address: ${uri}`,
  ];
  if (options.savedIdentity) lines.push('', options.savedIdentity);
  lines.push(
    `Local storage: ${options.storageEncrypted ? 'encrypted (storage key supplied)' : 'plaintext (no storage key)'}.`,
    '',
    options.hint,
    `Incoming policy: ${options.allowlist === undefined ? 'all authenticated senders' : options.allowlist.length === 0 ? 'deny all' : `${options.allowlist.length} allowed identities`}.`,
    'Press Ctrl+C to stop.',
  );
  return lines.join('\n');
}
