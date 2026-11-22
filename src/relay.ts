import { RelayPool, DEFAULT_RELAY_TIMEOUTS, type RelayTimeouts, type RelayLease } from './relay-pool.js';
export { DEFAULT_RELAY_TIMEOUTS, type RelayTimeouts } from './relay-pool.js';
import { RelayError } from './errors.js';
import { randomUUID } from 'node:crypto';
import { matchFilter, type Event, type Filter, type EventTemplate } from 'nostr-tools';
import type { Subscription as NostrSubscription } from 'nostr-tools/abstract-relay';

export interface Subscription {
  close(): void;
  ready: Promise<void>;
}

export interface Transport {
  query(relays: string[], filter: Filter): Promise<Event[]>;
  subscribe(relays: string[], filter: Filter, onEvent: (event: Event, source: 'live' | 'history') => void, onDisconnect?: (error: Error) => void): Subscription;
  publish(relays: string[], event: Event): Promise<void>;
  close(): void;
}

// Internal optional capability: a custom Transport without a socket probe stays unknown.
const socketProbes=new WeakMap<Transport,(relay:string)=>boolean>();
export function physicalConnectionState(transport:Transport,relay:string):boolean|undefined {
  return socketProbes.get(transport)?.(relay);
}

const localReadBoundaries=new WeakMap<Event,number>();
/** Verified layers may use this local-window boundary; it is never supplied by event tags. */
export function localReadBoundary(event:Event):number|undefined {return localReadBoundaries.get(event);}

const inboxSubscribers=new WeakMap<Transport,Transport['subscribe']>();
/** Only SDK long-lived inbox demand opts into a local initial-read window. */
export function subscribeInbox(transport:Transport,...args:Parameters<Transport['subscribe']>):Subscription {
  const subscribe=inboxSubscribers.get(transport);
  return subscribe?subscribe(...args):transport.subscribe(...args);
}

/** Opt-in performance metadata only: no event IDs, authors, content or raw URL paths/queries. */
export interface RelayTiming {
  operation: 'query' | 'publish';
  relay: string;
  kinds: number[];
  durationMs: number;
  outcome: 'ok' | 'error';
  code?: RelayError['code'];
}

export type RelayTimingObserver = (timing: RelayTiming) => void | Promise<void>;

export interface WebSocketTransportOptions extends Partial<RelayTimeouts> {
  maxConcurrentQueriesPerRelay?: number;
}

interface QueryQueue {
  active: number;
  pending: {
    start(): void;
    cancel(): void;
  }[];
}

export class WebSocketTransport implements Transport {
  private queries = new Map<string, QueryQueue>();
  private closed = false;
  readonly maxConcurrentQueriesPerRelay: number;
  private pool: RelayPool;
  readonly timeoutMs: number;
  readonly timeouts: Readonly<RelayTimeouts>;

  constructor(options: number | WebSocketTransportOptions = {}, private sign?: (template: EventTemplate) => Promise<Event>, private onTiming?: RelayTimingObserver) {
    // Preserve the numeric constructor as an explicit override of operation budgets.
    const configured = typeof options === 'number' ? {
      connectionTimeoutMs: options,
      eoseTimeoutMs: options,
      publishTimeoutMs: options,
      authTimeoutMs: options
    } : options;
    const { maxConcurrentQueriesPerRelay = 5, ...durations } = configured as WebSocketTransportOptions;
    if (!Number.isSafeInteger(maxConcurrentQueriesPerRelay) || maxConcurrentQueriesPerRelay < 1 || maxConcurrentQueriesPerRelay > 1000) {
      throw new TypeError('maxConcurrentQueriesPerRelay must be in 1..1000');
    }
    this.maxConcurrentQueriesPerRelay = maxConcurrentQueriesPerRelay;
    const timeouts = {
      ...DEFAULT_RELAY_TIMEOUTS, ...durations
    };
    for (const [name, value] of Object.entries(timeouts)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
        throw new TypeError(`${name} must be a positive timer duration`);
      }
    }
    this.timeouts = Object.freeze(timeouts);
    this.timeoutMs = timeouts.eoseTimeoutMs;
    this.pool = new RelayPool(timeouts, sign);
    socketProbes.set(this,url=>this.pool.isConnected(url));
    inboxSubscribers.set(this,(relays,filter,receive,disconnect)=>this.subscribeMode(relays,filter,receive,disconnect,true));
  }

  private timing(operation: RelayTiming['operation'], url: string, kinds: number[], start: number, error?: unknown) {
    if (!this.onTiming) {
      return;
    }
    let relay = '(invalid relay URL)';
    try {
      const value = new URL(url);
      if (['ws:', 'wss:'].includes(value.protocol)) {
        relay = value.origin;
      }
    }
    catch {
    }
    const metric: RelayTiming = {
      operation,
      relay,
      kinds: kinds.filter(kind => Number.isInteger(kind) && kind >= 0 && kind <= 65535),
      durationMs: Math.max(0, Math.round(performance.now() - start)),
      outcome: error === undefined ? 'ok' : 'error',
      ...(error instanceof RelayError ? {
        code: error.code
      } : {})
    };
    try {
      void Promise.resolve(this.onTiming(metric)).catch(() => {
      });
    }
    catch { /* Observers cannot alter transport success or retries. */
    }
  }

  subscribe(relays: string[], filter: Filter, onEvent: (event: Event, source: 'live' | 'history') => void, onDisconnect?: (error: Error) => void): Subscription {
    return this.subscribeMode(relays,filter,onEvent,onDisconnect,false);
  }

  private subscribeMode(relays: string[], filter: Filter, onEvent: (event: Event, source: 'live' | 'history') => void, onDisconnect: ((error: Error) => void) | undefined, localReadWindow: boolean, onAttempt?: () => void): Subscription {
    const closers: (() => void)[] = [];
    let stopped = false;
    const ready = Promise.all([...new Set(relays)].map(url => new Promise<void>((resolve, reject) => {
      let id = '';
      let live = false, settled = false, ended = false, rawCount = 0, acceptedCount = 0;
      let boundary: number | undefined;
      let lease: RelayLease | undefined, sub: NostrSubscription | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined, authTimer: ReturnType<typeof setTimeout> | undefined;
      const error = (code: RelayError['code'], reason?: string) => new RelayError(code === 'RELAY_EOSE_TIMEOUT' ? 'Relay EOSE timeout' : 'Relay subscription failed', { relay: url, operation: code.startsWith('RELAY_AUTH') ? 'auth' : 'subscribe', code, reason });
      const clear = () => { clearTimeout(hardTimer); clearTimeout(authTimer); hardTimer = undefined; authTimer = undefined; };
      const retire = () => {
        if (!sub) return;
        const prior = sub; sub = undefined;
        // Public cleanup: close() alone does not clear nostr-tools' EOSE timer.
        prior.oneose = undefined; prior.receivedEose(); prior.onclose = undefined; if (!prior.closed) prior.close();
      };
      const finish = () => { settled = true; clear(); resolve(); };
      const fail = (failure: Error) => {
        if (ended || stopped) return;
        ended = true; clear(); retire(); lease?.release();
        if (settled) { try { void Promise.resolve(onDisconnect?.(failure)).catch(() => {}); } catch {} }
        else reject(failure);
      };
      const waitAuth = () => {
        if (ended || stopped) return;
        live = false; boundary = undefined; id = ''; retire();
        authTimer ??= setTimeout(() => fail(error('RELAY_AUTH_TIMEOUT')), this.timeouts.authTimeoutMs);
      };
      const request = () => {
        if (ended || stopped) return;
        if (lease?.authenticating) { waitAuth(); return; }
        clearTimeout(authTimer); authTimer = undefined;
        live = false; boundary = undefined; rawCount = 0; acceptedCount = 0; retire();
        id = randomUUID();
        const attempt = id;
        onAttempt?.();
        // This caps repeated AUTH/replay cycles, not the library's EOSE timer.
        hardTimer ??= setTimeout(() => fail(error('RELAY_EOSE_TIMEOUT')), Math.min(2147483647, this.timeouts.eoseTimeoutMs + this.timeouts.authTimeoutMs));
        sub = lease!.subscribe(filter, {
          id, eoseTimeout: this.timeouts.eoseTimeoutMs,
          onevent: event => {
            if (ended || stopped || id !== attempt || lease?.authenticating || !matchFilter(filter, event)) return;
            acceptedCount++;
            if (!live && boundary !== undefined) localReadBoundaries.set(event, boundary);
            try { onEvent(event, live ? 'live' : 'history'); } catch { /* Isolate caller callbacks from library diagnostics. */ }
          },
          oneose: () => {
            if (ended || stopped || id !== attempt || lease?.authenticating || authTimer) return;
            if (live) {
              // Filtered/invalid wire entries cannot make a capped strict page look complete.
              if (!localReadWindow && rawCount !== acceptedCount) { fail(error('RELAY_HISTORY_INCOMPLETE')); return; }
              finish();
            } else if (localReadWindow) { boundary = Date.now() / 1000; finish(); }
            else fail(error('RELAY_EOSE_TIMEOUT'));
          },
          onclose: reason => {
            reason = typeof reason === 'string' ? reason : '';
            if (ended || stopped || id !== attempt) return;
            // The library has already removed/decremented this subscription.
            if (sub) { sub.oneose = undefined; sub.receivedEose(); sub = undefined; }
            if (this.sign && reason.startsWith('auth-required:')) { waitAuth(); return; }
            fail(error(reason.startsWith('auth-required:') ? 'RELAY_AUTH_REQUIRED' : 'RELAY_SUBSCRIPTION_REJECTED', reason));
          }
        });
        // The library matches filters before validating malformed events. An empty
        // local filter lets its verifier reject them quietly; the callback applies
        // the actual filter after verification. The original REQ is already sent.
        sub.filters = [{}];
      };
      closers.push(() => { ended = true; clear(); retire(); lease?.release(); resolve(); });
      try {
        lease = this.pool.acquire(url, {
          failed: fail, authenticating: waitAuth, authenticated: request,
          rawEvent: incoming => { if (incoming === id) rawCount++; },
          wireEose: incoming => {
            if (incoming !== id || ended || stopped || lease?.authenticating || authTimer) return;
            live = true; boundary = undefined;
          }
        });
        void lease.ready.then(request, fail);
      } catch (failure) { fail(failure instanceof RelayError ? failure : error('RELAY_CONNECTION_FAILED')); }
    }))).then(() => {});
    return { ready, close: () => { if (stopped) return; stopped = true; closers.forEach(close => close()); } };
  }

  private queuedQuery<T>(url: string, task: () => Promise<T>): Promise<T> {
    const closedError = () => new RelayError('Relay pool closed', {
      relay: url,
      operation: 'connect',
      code: 'RELAY_CLOSED'
    });
    if (this.closed) {
      return Promise.reject(closedError());
    }
    let key: string;
    try {
      key = new URL(url).href;
    }
    catch {
      return task();
    }
    let queue = this.queries.get(key);
    if (!queue) {
      queue = {
        active: 0, pending: []
      };
      this.queries.set(key, queue);
    }
    const current = queue;
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        current.active++;
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          current.active--;
          if (!this.closed) {
            current.pending.shift()?.start();
          }
          if (!current.active && !current.pending.length) {
            this.queries.delete(key);
          }
        });
      };
      if (current.active < this.maxConcurrentQueriesPerRelay) {
        start();
      }
      else {
        current.pending.push({
          start, cancel: () => reject(closedError())
        });
      }
    });
  }

  async query(relays: string[], filter: Filter): Promise<Event[]> {
    if (!relays.length) {
      throw new Error('No discovery relays');
    }
    const results = await Promise.allSettled([...new Set(relays)].map(relay => this.queuedQuery(relay, async () => {
      const events: Event[] = [], start = performance.now();
      let sub: Subscription | undefined;
      try {
        sub = this.subscribeMode([relay], filter, (event, source) => {
          if (source === 'history') {
            events.push(event);
          }
        }, undefined, false, () => { events.length = 0; });
        await sub.ready;
        this.timing('query', relay, filter.kinds ?? [], start);
        return events;
      }
      catch (error) {
        this.timing('query', relay, filter.kinds ?? [], start, error);
        throw error;
      }
      finally {
        sub?.close();
      }
    })));
    const successful = results.filter((r): r is PromiseFulfilledResult<Event[]> => r.status === 'fulfilled');
    if (!successful.length) {
      if (results.length === 1) {
        throw (results[0] as PromiseRejectedResult).reason;
      }
      throw new AggregateError(results.map(r => (r as PromiseRejectedResult).reason), 'All discovery relays failed');
    }
    // Preserve per-relay results; callers still own cross-relay deduplication.
    return successful.flatMap(r => r.value);
  }

  async publish(relays: string[], event: Event): Promise<void> {
    if (!relays.length) throw new Error('No delivery relays');
    await Promise.any([...new Set(relays)].map(url => new Promise<void>((resolve, reject) => {
      const start = performance.now();
      let settled = false, generation = 0, attempted = false, authRetries = 0, lease: RelayLease | undefined;
      let authTimer: ReturnType<typeof setTimeout> | undefined, hardTimer: ReturnType<typeof setTimeout> | undefined;
      const error = (code: RelayError['code'], reason?: string) => new RelayError('Relay publication failed', { relay: url, operation: code.startsWith('RELAY_AUTH') ? 'auth' : 'publish', code, reason, eventKind: event.kind });
      const finish = (failure?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(authTimer); clearTimeout(hardTimer); lease?.release();
        this.timing('publish', url, [event.kind], start, failure);
        failure ? reject(failure) : resolve();
      };
      const waitAuth = () => {
        if (settled) return;
        generation++;
        authTimer ??= setTimeout(() => finish(error('RELAY_AUTH_TIMEOUT')), this.timeouts.authTimeoutMs);
      };
      const publish = (afterAuth = false) => {
        if (settled) return;
        hardTimer ??= setTimeout(() => finish(error('RELAY_ACK_TIMEOUT')), Math.min(2147483647, this.timeouts.publishTimeoutMs + this.timeouts.authTimeoutMs));
        if (lease?.authenticating) { waitAuth(); return; }
        clearTimeout(authTimer); authTimer = undefined;
        const replay = afterAuth && attempted;
        if (replay && authRetries++ >= 1) { finish(error('RELAY_AUTH_REQUIRED')); return; }
        attempted = true;
        const attempt = ++generation;
        void lease!.publish(event, replay).then(() => { if (attempt === generation) finish(); }, failure => {
          if (settled || attempt !== generation) return;
          const reason = failure instanceof Error ? failure.message : '';
          if (this.sign && reason.startsWith('auth-required:')) {
            if (authRetries >= 1) finish(error('RELAY_AUTH_REQUIRED', reason));
            else waitAuth();
            return;
          }
          finish(error(reason === 'publish timed out' ? 'RELAY_ACK_TIMEOUT' : reason.startsWith('auth-required:') ? 'RELAY_AUTH_REQUIRED' : 'RELAY_EVENT_REJECTED', reason));
        });
      };
      try {
        lease = this.pool.acquire(url, { failed: finish, authenticating: waitAuth, authenticated: () => publish(true), rawEvent: () => {}, wireEose: () => {} });
        void lease.ready.then(() => publish(), finish);
      } catch (failure) { finish(failure instanceof RelayError ? failure : error('RELAY_CONNECTION_FAILED')); }
    })));
  }

  close() {
    this.closed = true;
    for (const queue of this.queries.values()) {
      for (const pending of queue.pending.splice(0)) {
        pending.cancel();
      }
    }
    this.pool.close();
  }
}
