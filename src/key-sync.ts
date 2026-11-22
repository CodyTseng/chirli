import { generateSecretKey, getPublicKey, nip44, type Event } from 'nostr-tools';
import { hexKey, signChecked, validTimestamp, type Identity } from './protocol.js';
import { websocketURL } from './metadata.js';
import { relayUnion } from './relay-roles.js';
import type { Store } from './store.js';
import type { Transport, Subscription } from './relay.js';
import { verifyEvent } from 'nostr-tools';
import { InboxSubscription } from './inbox.js';

export interface KeySyncOptions {
  timeoutMs?: number;
}

interface Saved {
  event: Event;
  relays: string[];
  done: boolean;
}

/** Same-identity NIP-4E transfer only; identity signing secrets are never exportable. */
export class KeySync {
  private stopped = false;
  private generation = 0;
  private responses: Record<string, Saved>;
  private jobs = new Map<string, Promise<void>>();
  private requests = new Map<string, Promise<Uint8Array>>();
  private cancel = new Set<() => void>();
  private timeout: number;

  constructor(private identity: Identity, private store: Store, private transport: Transport, private relays: string[], private exportKey: (key?: string) => Uint8Array | undefined, private current: () => string | undefined, options: KeySyncOptions = {}) {
    this.timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 120000) {
      throw new TypeError('keySync.timeoutMs must be in 100..120000');
    }
    this.responses = store.metadata<Record<string, Saved>>('key-sync-responses') ?? {};
  }

  private verified(event: Event, kind: number) {
    try {
      return event.kind === kind && event.pubkey === this.identity.pubkey && validTimestamp(event.created_at) && verifyEvent(JSON.parse(JSON.stringify(event)));
    }
    catch {
      return false;
    }
  }

  private single(event: Event, name: string) {
    const tags = event.tags.filter(tag => tag[0] === name);
    return tags.length === 1 ? tags[0][1] : undefined;
  }

  handle(event: Event): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const now = Math.floor(Date.now() / 1000);
    if (!this.verified(event, 4454) || event.content !== '' || event.created_at < now - 300 || event.created_at > now + 60) {
      return Promise.resolve();
    }
    const p = this.single(event, 'P'), alias = this.single(event, 'pubkey'), target = this.single(event, 'n');
    if ((!p && !alias) || !hexKey(p ?? alias) || (p && alias && p !== alias) || event.tags.filter(t => ['P', 'pubkey', 'n'].includes(t[0])).some(t => t.length !== 2) || ['P', 'pubkey', 'n'].some(name => event.tags.filter(t => t[0] === name).length > 1) || (target !== undefined && !hexKey(target))) {
      return Promise.resolve();
    }
    const requester = (p ?? alias)!;
    if (this.responses[event.id]?.done) {
      return Promise.resolve();
    }
    const existing = this.jobs.get(event.id);
    if (existing) {
      return existing;
    }
    const generation = this.generation;
    const task = (async () => {
      let saved = this.responses[event.id];
      if (!saved) {
        const key = this.exportKey(target);
        if (!key) {
          return;
        }
        try {
          if (getPublicKey(key) === this.identity.pubkey) {
            return;
          }
          const ephemeral = generateSecretKey();
          let content: string, sender: string;
          try {
            sender = getPublicKey(ephemeral);
            content = nip44.v2.encrypt(Buffer.from(key).toString('hex'), nip44.v2.utils.getConversationKey(ephemeral, requester));
          }
          finally {
            ephemeral.fill(0);
          }
          const response = await signChecked(this.identity, {
            kind: 4455,
            created_at: now,
            tags: [['P', sender], ['p', this.identity.pubkey], ['p', requester]],
            content
          });
          if (this.stopped || this.generation !== generation) {
            return;
          }
          const hints = event.tags.filter(t => t[0] === 'relay' && websocketURL(t[1])).slice(0, 8).map(t => t[1]);
          saved = {
            event: response,
            relays: relayUnion(this.relays, hints),
            done: false
          };
          this.responses[event.id] = saved;
          this.persist();
        }
        finally {
          key.fill(0);
        }
      }
      if (this.stopped || this.generation !== generation) {
        return;
      }
      this.persist();
      await this.transport.publish(saved.relays, saved.event);
      this.responses[event.id] = {
        ...saved, done: true
      };
      this.persist();
    })().finally(() => this.jobs.delete(event.id));
    this.jobs.set(event.id, task);
    return task;
  }

  private persist() {
    const entries = Object.entries(this.responses).sort((a, b) => b[1].event.created_at - a[1].event.created_at);
    this.responses = Object.fromEntries(entries.slice(0, 512));
    this.store.saveMetadata('key-sync-responses', this.responses);
  }

  request(expected: string): Promise<Uint8Array> {
    if (this.stopped) {
      return Promise.reject(new Error('Key synchronization stopped'));
    }
    const existing = this.requests.get(expected);
    if (existing) {
      return existing;
    }
    const task = this.runRequest(expected).finally(() => this.requests.delete(expected));
    this.requests.set(expected, task);
    return task;
  }

  private async runRequest(expected: string) {
    if (!hexKey(expected) || expected === this.identity.pubkey) {
      throw new Error('Only separated encryption keys can be synchronized');
    }
    const secret = generateSecretKey(), client = getPublicKey(secret);
    let sub: Subscription | undefined, timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
    let finished = false, resolve!: (key: Uint8Array) => void, reject!: (error: Error) => void, abort!: (error: Error) => void, aborted: Error | undefined;
    const response = new Promise<Uint8Array>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void response.catch(() => {
    });
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = reject;
    });
    void canceled.catch(() => {
    });
    const cancel = (error: Error) => {
      if (aborted) {
        return;
      }
      aborted = error;
      abort(error);
      if (!finished) {
        finished = true;
        reject(error);
      }
    };
    const check = () => {
      if (aborted) {
        throw aborted;
      }
    };
    stop = () => cancel(new Error('Key synchronization stopped'));
    this.cancel.add(stop);
    try {
      sub = new InboxSubscription({
        transport: this.transport,
        store: this.store,
        relays: this.relays,
        filter: {
          kinds: [4455],
          authors: [this.identity.pubkey],
          '#p': [client]
        },
        reconnect: false,
        recovery: false,
        error: () => {
        },
        reconnected: async () => {
        },
        receive: event => {
          if (finished || !this.verified(event, 4455) || !event.tags.some(t => t[0] === 'p' && t[1] === client) || event.created_at < Math.floor(Date.now() / 1000) - 300 || event.created_at > Math.floor(Date.now() / 1000) + 60) {
            return;
          }
          const sender = this.single(event, 'P');
          if (!hexKey(sender)) {
            return;
          }
          try {
            const raw = nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(secret, sender));
            if (!hexKey(raw)) {
              return;
            }
            const value = new Uint8Array(Buffer.from(raw, 'hex'));
            if (getPublicKey(value) !== expected || this.current() !== expected) {
              value.fill(0);
              return;
            }
            finished = true;
            resolve(value);
          }
          catch { /* Ignore unrelated, forged or undecryptable responses. */
          }
        }
      });
      timer = setTimeout(() => cancel(new Error('Key synchronization timed out')), this.timeout);
      await Promise.race([sub.ready, response.then(() => {
        }), canceled]);
      check();
      if (finished) {
        return await response;
      }
      const request = await Promise.race([signChecked(this.identity, {
          kind: 4454,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['P', client], ['pubkey', client], ...this.relays.map(relay => ['relay', relay]), ['n', expected]],
          content: ''
        }), canceled]);
      check();
      await Promise.race([this.transport.publish(this.relays, request), canceled]);
      check();
      return await response;
    }
    finally {
      this.cancel.delete(stop);
      clearTimeout(timer);
      sub?.close();
      secret.fill(0);
    }
  }

  start() {
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    this.generation++;
    for (const cancel of this.cancel) {
      cancel();
    }
  }

  async idle() {
    await Promise.allSettled([...this.jobs.values(), ...this.requests.values()]);
  }
}
