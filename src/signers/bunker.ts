import WebSocket from 'ws';
import { generateSecretKey, getPublicKey, getEventHash, verifyEvent, type Event, type EventTemplate } from 'nostr-tools';
import { BunkerSigner } from 'nostr-tools/nip46';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { hexKey } from '../protocol.js';
import { SignerError } from '../errors.js';
import type { Signer } from '../signer.js';

export interface BunkerOptions {
  clientSecret?: Uint8Array;
  timeoutMs?: number;
}

function relayURL(value: string): boolean {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.hash;
  }
  catch {
    return false;
  }
}

/** Lazy, shared NIP-46 handshake; closing releases this session, never logs out/deletes an account. */
export function bunkerSigner(input: string, options: BunkerOptions = {}): Signer & Required<Pick<Signer, 'close' | 'nip04Encrypt' | 'nip04Decrypt'>> {
  let pointer: {
    pubkey: string;
    relays: string[];
    secret: string | null;
  };
  try {
    const url = new URL(input), relays = [...new Set(url.searchParams.getAll('relay'))];
    if (url.protocol !== 'bunker:' || !hexKey(url.hostname) || url.username || url.password || url.port || (url.pathname && url.pathname !== '/') || url.hash || !relays.length || !relays.every(relayURL)) {
      throw new Error();
    }
    pointer = {
      pubkey: url.hostname,
      relays,
      secret: url.searchParams.get('secret')
    };
  }
  catch {
    throw new TypeError('Invalid bunker connection URI');
  }
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new TypeError('timeoutMs must be in 1..300000');
  }
  const clientSecret = new Uint8Array(options.clientSecret ?? generateSecretKey());
  getPublicKey(clientSecret);
  const pool = new AbstractSimplePool({
    verifyEvent: event => verifyEvent(JSON.parse(JSON.stringify(event))),
    websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket,
    maxWaitForConnection: timeoutMs,
    enableReconnect: false,
    enablePing: false,
  });
  let closed = false, inner: BunkerSigner | undefined, connecting: Promise<BunkerSigner> | undefined;
  let pinnedAccount: string | undefined;
  const candidates = new Set<BunkerSigner>();
  const check = () => {
    if (closed) {
      throw new SignerError('session', 'SIGNER_CLOSED');
    }
  };
  async function bounded<T>(operation: string, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([promise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SignerError(operation, 'SIGNER_TIMEOUT')), timeoutMs);
        })]);
      check();
      return value;
    }
    catch (error) {
      if (closed) {
        throw new SignerError(operation, 'SIGNER_CLOSED');
      }
      if (error instanceof SignerError) {
        throw error;
      }
      throw new SignerError(operation, error instanceof Error && /timeout/i.test(error.message) ? 'SIGNER_TIMEOUT' : 'SIGNER_FAILED');
    }
    finally {
      clearTimeout(timer);
    }
  }
  async function discard(signer: BunkerSigner) {
    if (!candidates.delete(signer)) {
      return;
    }
    if (inner === signer) {
      inner = undefined;
    }
    await signer.close().catch(() => {
    });
    if (candidates.size === 0) {
      pool.close(pointer.relays);
    }
  }
  function ensure(): Promise<BunkerSigner> {
    try {
      check();
    }
    catch (error) {
      return Promise.reject(error);
    }
    if (inner) {
      return Promise.resolve(inner);
    }
    if (connecting) {
      return connecting;
    }
    const candidate = BunkerSigner.fromBunker(clientSecret, {
      ...pointer, relays: [...pointer.relays]
    }, {
      pool,
      timeout: timeoutMs,
    });
    candidates.add(candidate);
    const pending = (async () => {
      try {
        await bounded('connect', candidate.connect({
          name: 'Chirli'
        }));
        pointer.secret = null; // Reconnect with the same client key, never reuse the single-use token.
        const account = await bounded('get_public_key', candidate.getPublicKey());
        if (!hexKey(account) || (pinnedAccount && pinnedAccount !== account)) {
          throw new SignerError('account binding');
        }
        pinnedAccount = account;
        await bounded('switch_relays', candidate.switchRelays());
        check();
        inner = candidate;
        return candidate;
      }
      catch (error) {
        await discard(candidate);
        throw error;
      }
    })().finally(() => {
      if (connecting === pending) {
        connecting = undefined;
      }
    });
    connecting = pending;
    return pending;
  }
  async function request<T>(operation: string, run: (signer: BunkerSigner) => Promise<T>): Promise<T> {
    const signer = await ensure();
    try {
      return await bounded(operation, run(signer));
    }
    catch (error) {
      if (error instanceof SignerError && error.code === 'SIGNER_TIMEOUT') {
        await discard(signer);
      }
      throw error;
    }
  }
  return {
    async getPublicKey() {
      await ensure();
      check();
      return pinnedAccount!;
    },
    async signEvent(template) {
      const snapshot = structuredClone(template);
      await ensure();
      const account = pinnedAccount!;
      const expected = getEventHash({
        ...snapshot, pubkey: account
      });
      const signed = await request('sign_event', signer => signer.signEvent(snapshot));
      if (signed.pubkey !== account || signed.id !== expected || !verifyEvent(JSON.parse(JSON.stringify(signed)))) {
        throw new SignerError('sign_event validation');
      }
      return signed;
    },
    nip44Encrypt: (peer, text) => request('nip44_encrypt', signer => signer.nip44Encrypt(peer, text)),
    nip44Decrypt: (peer, content) => request('nip44_decrypt', signer => signer.nip44Decrypt(peer, content)),
    nip04Encrypt: (peer, text) => request('nip04_encrypt', signer => signer.nip04Encrypt(peer, text)),
    nip04Decrypt: (peer, content) => request('nip04_decrypt', signer => signer.nip04Decrypt(peer, content)),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      clientSecret.fill(0);
      pointer.secret = null;
      inner = undefined;
      await Promise.all([...candidates].map(candidate => candidate.close().catch(() => {
      })));
      candidates.clear();
      pool.destroy();
    },
  };
}
