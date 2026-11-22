import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import * as nip04 from 'nostr-tools/nip04';
import { SignerError } from '../errors.js';
import type { Signer } from '../signer.js';

/** Local account signer. Secret bytes live only in this instance's closure. */
export function nsecSigner(nsec: string | Uint8Array): Signer & Required<Pick<Signer, 'close' | 'nip04Encrypt' | 'nip04Decrypt'>> {
  let secret: Uint8Array;
  let pubkey: string;
  try {
    if (typeof nsec === 'string') {
      const decoded = decode(nsec);
      if (decoded.type !== 'nsec') {
        throw new Error();
      }
      secret = new Uint8Array(decoded.data);
    }
    else {
      // Copy caller bytes: closing one signer must never wipe another owner's key.
      secret = new Uint8Array(nsec);
    }
    pubkey = getPublicKey(secret);
  }
  catch {
    throw new TypeError('Invalid nsec secret key');
  }
  let closed = false;
  const check = () => {
    if (closed) {
      throw new SignerError('local', 'SIGNER_CLOSED');
    }
  };
  return {
    async getPublicKey() {
      check();
      return pubkey;
    },
    async signEvent(template) {
      check();
      return finalizeEvent(template, secret);
    },
    async nip44Encrypt(peer, text) {
      check();
      return nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(secret, peer));
    },
    async nip44Decrypt(peer, content) {
      check();
      return nip44.v2.decrypt(content, nip44.v2.utils.getConversationKey(secret, peer));
    },
    async nip04Encrypt(peer, text) {
      check();
      return nip04.encrypt(secret, peer, text);
    },
    async nip04Decrypt(peer, content) {
      check();
      return nip04.decrypt(secret, peer, content);
    },
    async close() {
      closed = true;
      secret.fill(0);
    },
  };
}
