import { getPublicKey } from 'nostr-tools';
import {
  compatibilityEnvelope,
  identitySplitEnvelope,
  identityMessagingKey,
  splitEnvelope,
  standardEnvelope,
  timestamp,
  validateNip17Identity,
  type EnvelopePolicy,
  type Identity,
  type DecodedEnvelope,
} from './protocol.js';
import { messagingMetadata, standardRelays } from './metadata.js';
import type { MessagingMetadata } from './messaging-metadata.js';
import { recordPeerMetadata } from './nip4e-compat.js';
import type { Store } from './store.js';
import type { Transport } from './relay.js';
import type { EncryptionKeys } from './keys.js';

export type ProtocolMode = 'nip4e' | 'nip17';

export interface PeerMetadata {
  encryptionPubkey: string;
  relays: string[];
  envelope?: EnvelopePolicy;
}

export interface Recipient extends PeerMetadata {
  pubkey: string;
}

export interface MessagingProtocol {
  readonly mode: ProtocolMode;
  readonly scope: string;
  readonly envelope: EnvelopePolicy;
  prepare(): Promise<void>;
  resolve(peer: string, store: Store, transport: Transport, discovery: string[], force?: boolean): Promise<PeerMetadata>;
  recipients(peer: string, store: Store, transport: Transport, discovery: string[]): Promise<Recipient[]>;
  remember(decoded: DecodedEnvelope, store: Store): void;
}

export function protocolScope(mode: ProtocolMode, identity: Identity) {
  if (mode !== 'nip17' && mode !== 'nip4e') {
    throw new Error(`Unsupported protocol mode: ${String(mode)}`);
  }
  identityMessagingKey(identity);
  if (mode === 'nip17') {
    validateNip17Identity(identity);
  }
  return mode === 'nip17' ? `nip17:${identity.pubkey}` : identity.pubkey;
}

/** Mode selects the outgoing key, while authenticated peer evidence selects the wire profile. */
export function createMessagingProtocol(mode: ProtocolMode, identity: Identity, keys: EncryptionKeys, metadata?: MessagingMetadata, ownRelays: string[] = []): MessagingProtocol {
  const scope = mode === 'nip17' ? `nip17:${identity.pubkey}` : identity.pubkey;
  const resolved = (peer: string, store: Store, events: Awaited<ReturnType<typeof messagingMetadata>>): PeerMetadata => {
    recordPeerMetadata(store, events);
    const evidence = store.evidence(peer), declaration = store.declaration(peer);
    if (declaration && !evidence) {
      throw new Error('No valid encryption key in peer NIP-4E declaration');
    }
    return {
      encryptionPubkey: evidence?.key ?? peer,
      relays: (() => {
        try {
          return standardRelays(events);
        }
        catch {
          if (ownRelays.length) {
            return metadata ? metadata.ownDmRelays(ownRelays) : [...ownRelays];
          }
          throw new Error('No DM relay fallback configured');
        }
      })(),
      envelope: store.isSplitPeer(peer) ? (mode === 'nip4e' ? splitEnvelope : identitySplitEnvelope) : standardEnvelope
    };
  };
  const protocol: MessagingProtocol = {
    mode,
    scope,
    envelope: compatibilityEnvelope,
    prepare: () => keys.prepare(),
    async resolve(peer, store, transport, discovery, force = false) {
      return resolved(peer, store, await (metadata ? metadata.read(peer, [10044, 10050], force) : messagingMetadata(peer, [10044, 10050], transport, discovery)));
    },
    async recipients(peer, store, transport, discovery) {
      // Read independent snapshots concurrently; apply peer evidence only after own-key checks pass.
      const [, selfEvents, peerEvents] = await Promise.all([
        keys.prepare(), metadata ? metadata.read(identity.pubkey, [10050]) : messagingMetadata(identity.pubkey, [10050], transport, discovery),
        peer === identity.pubkey ? Promise.resolve(undefined) : (metadata ? metadata.read(peer, [10044, 10050]) : messagingMetadata(peer, [10044, 10050], transport, discovery)),
      ]);
      const self = {
        pubkey: identity.pubkey,
        encryptionPubkey: mode === 'nip4e' ? getPublicKey(identity.encryptionKey!) : identity.pubkey,
        relays: (() => {
          try {
            return standardRelays(selfEvents);
          }
          catch {
            return [...ownRelays];
          }
        })(),
        envelope: mode === 'nip4e' ? splitEnvelope : standardEnvelope
      };
      return peerEvents ? [{
          pubkey: peer, ...resolved(peer, store, peerEvents)
        }, self] : [self];
    },
    remember({ rumor, seal, encryptionPubkey }, store) {
      if (seal.tags.some(t => t[0] === 'n')) {
        store.markSplitPeer(rumor.pubkey);
      }
      store.observe(rumor.pubkey, encryptionPubkey, timestamp(rumor), rumor.id);
    },
  };
  return protocol;
}
