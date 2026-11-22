import qrcode from 'qrcode-generator';
import { npubEncode } from 'nostr-tools/nip19';

/** A compact, explicitly colored QR stays readable on both light and dark terminals. */
export function identityQRCode(uri: string, columns = 80): string | undefined {
  const code = qrcode(0, 'M');
  code.addData(uri, 'Byte');
  code.make();
  const lines = code.createASCII(1, 4).split('\n');
  if (lines[0].length > columns) return undefined;
  return lines.map(line => `\x1b[97;40m${line}\x1b[0m`).join('\n');
}

/** Build the entire banner before writing so its readiness marker includes the identity. */
export function readyBanner(options: {
  name: string;
  hint: string;
  pubkey: string;
  mode: string;
  relays: number;
  allowlist?: readonly string[];
  terminal?: boolean;
  columns?: number;
  storageEncrypted: boolean;
  savedIdentity?: string;
}): string {
  const npub = npubEncode(options.pubkey);
  const uri = `nostr:${npub}`;
  const lines = [
    '',
    `Chirli ${options.name} ready (${options.mode}; ${options.relays} configured relay(s)).`,
    '',
    `Bot npub: ${npub}`,
    `Bot identity: ${options.pubkey}`,
    `Nostr address: ${uri}`,
  ];
  if (options.terminal) {
    const code = identityQRCode(uri, options.columns);
    if (code) lines.push('', code);
  }
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
