import { SignerError } from './errors.js';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  nip44,
  validateEvent,
  verifyEvent,
  type Event,
  type EventTemplate,
} from 'nostr-tools';
export { generateSecretKey, getPublicKey } from 'nostr-tools';

export type Rumor = Omit<Event, 'sig'>;

export interface Identity {
  pubkey: string;
  /** Split messaging key in nip4e; identity secret itself in nip17. */
  encryptionKey?: Uint8Array;
  /** Legacy identity-key crypto capability; identityEncryption also works in either mode. */
  messaging?: MessagingKey;
  oldEncryptionKeys?: Uint8Array[];
  /** Identity-key NIP-44 capability, also required in split mode for standard peers. */
  identityEncryption?: MessagingKey;
  sign(template: EventTemplate): Promise<Event>;
}

export interface LocalIdentity extends Identity {
  encryptionKey: Uint8Array;
}

/** Local split-key account for protocol fixtures and internal envelope tooling. */
export function localIdentity(secret = generateSecretKey(), encryptionKey = generateSecretKey()): LocalIdentity {
  return {
    pubkey: getPublicKey(secret),
    encryptionKey,
    identityEncryption: localMessagingKey(secret),
    sign: async (t) => finalizeEvent(t, secret)
  };
}

/** Unified identity signing/decryption key for the default NIP-17 mode. */
export function localNip17Identity(secret = generateSecretKey()): LocalIdentity {
  return localIdentity(secret, secret);
}

/** Matches Client's default NIP-17 mode. Caller owns persistence of the identity secret. */
export const createIdentity = localNip17Identity;

/** Explicit split-key identity; select Client mode: nip4e. */
export const createSplitIdentity = localIdentity;

export const hexKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** Reject fractional/negative/unsafe protocol times before crypto or SQLite ordering. */
export function validTimestamp(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= Math.floor((Number.MAX_SAFE_INTEGER - 999) / 1000);
}

export function timestamp(r: Pick<Rumor, 'tags' | 'created_at'>): number {
  const ms = r.tags.find(t => t[0] === 'ms')?.[1];
  return r.created_at * 1000 + (ms && /^\d{1,3}$/.test(ms) && +ms < 1000 ? +ms : 0);
}

export function replyTarget(rumor: Pick<Rumor, 'tags'>): string | undefined {
  const target = rumor.tags?.find(tag => tag[0] === 'e')?.[1];
  return hexKey(target) ? target : undefined;
}

export function rumor(identity: string, peer: string, text: string, now = Date.now(), replyTo?: string): Rumor {
  return dmRumor(14, identity, peer, text, now, replyTo);
}

export function reactionRumor(identity: string, peer: string, target: string, reaction: string): Rumor {
  return dmRumor(7, identity, peer, reaction, Date.now(), target);
}

function dmRumor(kind: 7 | 14, identity: string, peer: string, content: string, now: number, reference?: string): Rumor {
  const tags = [['p', peer], ['ms', String(now % 1000)], ['nonce', Buffer.from(generateSecretKey()).toString('hex')]];
  if (reference !== undefined) tags.push(['e', reference]);

  const r = {
    pubkey: identity,
    kind,
    content,
    created_at: Math.floor(now / 1000),
    tags,
  };
  return {
    ...r, id: getEventHash(r)
  };
}

const encrypt = (text: string, secret: Uint8Array, peer: string) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(secret, peer));

const decrypt = (text: string, secret: Uint8Array, peer: string) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(secret, peer));

export interface MessagingKey {
  publicKey: string;
  asynchronous?: boolean;
  encrypt(text: string, peer: string): string | Promise<string>;
  decrypt(text: string, peer: string): string | Promise<string>;
}

export function localMessagingKey(key: Uint8Array): MessagingKey {
  return {
    publicKey: getPublicKey(key),
    encrypt: (text, peer) => encrypt(text, key, peer),
    decrypt: (text, peer) => decrypt(text, key, peer)
  };
}

export function splitKey(identity: Identity): Uint8Array {
  if (!identity.encryptionKey) {
    throw new Error('nip4e requires a local, separate messaging encryptionKey');
  }
  return identity.encryptionKey;
}

export interface EnvelopePolicy {
  keys(identity: Identity): MessagingKey[];
  tags(identity: Identity): string[][];
  sealTime(r: Rumor): number;
  senderKey(seal: Event): string | undefined;
  acceptsRoute(event: Event, account: string): boolean;
}

const randomPast = () => Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800);

export const splitEnvelope: EnvelopePolicy = {
  keys: identity => [splitKey(identity), ...(identity.oldEncryptionKeys ?? [])].map(localMessagingKey),
  tags: identity => [['n', getPublicKey(splitKey(identity))]],
  sealTime: r => r.created_at,
  senderKey: seal => seal.tags.find(t => t[0] === 'n')?.[1],
  acceptsRoute: (event, account) => event.tags.some(t => t[0] === 'p' && t[1] === account),
};

export function identityMessagingKey(identity: Identity): MessagingKey {
  const capability = identity.identityEncryption ?? identity.messaging;
  if (capability) {
    if (capability.publicKey !== identity.pubkey) {
      throw new Error('Identity encryption capability must match identity pubkey');
    }
    return capability;
  }
  if (identity.encryptionKey && getPublicKey(identity.encryptionKey) === identity.pubkey) {
    return localMessagingKey(identity.encryptionKey);
  }
  throw new Error('Both protocols require identity-key NIP-44 capability; use localIdentity/localNip17Identity or identityFromSigner');
}

export function validateNip17Identity(identity: Identity): void {
  identityMessagingKey(identity);
  if (identity.encryptionKey && getPublicKey(identity.encryptionKey) !== identity.pubkey) {
    throw new Error('nip17 requires the identity secret; select mode: nip4e explicitly for a separate encryptionKey');
  }
}

export const standardEnvelope: EnvelopePolicy = {
  keys: identity => [identityMessagingKey(identity)],
  tags: () => [],
  sealTime: () => randomPast(),
  senderKey: seal => seal.tags.length === 0 ? seal.pubkey : undefined,
  acceptsRoute: (event, account) => {
    const recipients = event.tags.filter(t => t[0] === 'p');
    return recipients.length === 1 && recipients[0][1] === account;
  },
};

/** Accept standard seals or the explicit, authenticated PsstPsst split-key extension. */
export const compatibilityEnvelope: EnvelopePolicy = {
  ...standardEnvelope,
  keys: identity => {
    const keys = [identity.encryptionKey, ...(identity.oldEncryptionKeys ?? [])].filter((key): key is Uint8Array => !!key && getPublicKey(key) !== identity.pubkey).map(localMessagingKey);
    return [...keys, identityMessagingKey(identity)];
  },
  senderKey: seal => seal.tags.length === 0 ? seal.pubkey : seal.tags.find(tag => tag[0] === 'n')?.[1],
};

/** PsstPsst requires n even when the sender encrypts with its identity key. */
export const identitySplitEnvelope: EnvelopePolicy = {
  ...compatibilityEnvelope,
  keys: identity => [identityMessagingKey(identity)],
  tags: identity => [['n', identity.pubkey]],
  sealTime: rumor => rumor.created_at,
};

/** A signer may be external, but must return the exact event requested. */
export async function signChecked(identity: Identity, template: EventTemplate): Promise<Event> {
  const expectedId = getEventHash({
    ...template, pubkey: identity.pubkey
  });
  const event = await identity.sign(template);
  if (event.pubkey !== identity.pubkey || event.id !== expectedId || !verifyEvent(JSON.parse(JSON.stringify(event)))) {
    throw new Error('Identity signer returned an invalid or altered event');
  }
  return event;
}

export async function wrap(r: Rumor, identity: Identity, recipient: string, encryptionPubkey: string, policy: EnvelopePolicy = splitEnvelope): Promise<Event> {
  const [key] = policy.keys(identity);
  const seal = await signChecked(identity, {
    kind: 13,
    created_at: policy.sealTime(r),
    tags: policy.tags(identity),
    content: await key.encrypt(JSON.stringify(r), encryptionPubkey)
  });
  const ephemeral = generateSecretKey();
  return finalizeEvent({
    kind: 1059,
    created_at: randomPast(),
    tags: [['p', recipient]],
    content: encrypt(JSON.stringify(seal), ephemeral, encryptionPubkey)
  }, ephemeral);
}

export type DecodedEnvelope = {
  rumor: Rumor;
  seal: Event;
  encryptionPubkey: string;
};

type Decryption = {
  key: MessagingKey;
  content: string;
  peer: string;
};

/** One validation state machine serves synchronous local and asynchronous signer crypto. */
function* decode(event: Event, identity: Identity, policy: EnvelopePolicy): Generator<Decryption, DecodedEnvelope | undefined, string> {
  try {
    event = JSON.parse(JSON.stringify(event));
    if (event.kind !== 1059 || !validTimestamp(event.created_at) || !verifyEvent(event) || !policy.acceptsRoute(event, identity.pubkey)) {
      return;
    }
    for (const key of policy.keys(identity)) {
      try {
        const seal: Event = JSON.parse(yield {
          key,
          content: event.content,
          peer: event.pubkey
        });
        if (seal.kind !== 13 || !validTimestamp(seal.created_at) || !verifyEvent(seal)) {
          continue;
        }
        const encryptionPubkey = policy.senderKey(seal);
        if (!hexKey(encryptionPubkey)) {
          continue;
        }
        const r: Rumor = JSON.parse(yield {
          key,
          content: seal.content,
          peer: encryptionPubkey
        });
        if (!validateEvent(r) || !validTimestamp(r.created_at) || r.kind !== 14 || r.pubkey !== seal.pubkey || r.id !== getEventHash(r) || 'sig' in r) {
          continue;
        }
        const peers = r.tags.filter(t => t[0] === 'p');
        if (peers.length !== 1 || !hexKey(peers[0][1]) || r.tags.some(t => ['h', 'action'].includes(t[0]))) {
          continue;
        }
        if (r.pubkey !== identity.pubkey && peers[0][1] !== identity.pubkey) {
          continue;
        }
        return {
          rumor: r,
          seal,
          encryptionPubkey
        };
      }
      catch (error) {
        if (error instanceof SignerError) {
          throw error;
        } /* Try retained keys without logging secrets. */
      }
    }
  }
  catch (error) {
    if (error instanceof SignerError) {
      throw error;
    } /* Malformed events never cross the verified boundary. */
  }
}

export function unwrap(event: Event, identity: Identity, policy: EnvelopePolicy = splitEnvelope): DecodedEnvelope | undefined {
  const decoder = decode(event, identity, policy);
  let step = decoder.next();
  while (!step.done) {
    const { key, content, peer } = step.value;
    if (key.asynchronous) {
      decoder.return(undefined);
      return;
    }
    try {
      const text = key.decrypt(content, peer);
      if (typeof text !== 'string') {
        void text.catch(() => {
        });
        decoder.return(undefined);
        return;
      }
      step = decoder.next(text);
    }
    catch (error) {
      step = decoder.throw(error);
    }
  }
  return step.value;
}

export async function unwrapAsync(event: Event, identity: Identity, policy: EnvelopePolicy = splitEnvelope): Promise<DecodedEnvelope | undefined> {
  const decoder = decode(event, identity, policy);
  let step = decoder.next();
  while (!step.done) {
    const { key, content, peer } = step.value;
    try {
      step = decoder.next(await key.decrypt(content, peer));
    }
    catch (error) {
      step = decoder.throw(error);
    }
  }
  return step.value;
}

export function announcement(identity: Identity, now = Math.floor(Date.now() / 1000)): Promise<Event> {
  return signChecked(identity, {
    kind: 10044,
    created_at: now,
    tags: [['n', getPublicKey(splitKey(identity))]],
    content: ''
  });
}
