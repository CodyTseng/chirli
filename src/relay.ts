import { RelayPool, DEFAULT_RELAY_TIMEOUTS, type RelayTimeouts, type RelayLease } from './relay-pool.js';
export { DEFAULT_RELAY_TIMEOUTS, type RelayTimeouts } from './relay-pool.js';
import { RelayError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { Event, Filter, EventTemplate } from 'nostr-tools';

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
    const closers: (() => void)[] = [];
    let stopped = false;
    const ready = Promise.all([...new Set(relays)].map(url => new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      let live = false, initialComplete = false, ended = false;
      let lease: RelayLease | undefined, timer: ReturnType<typeof setTimeout> | undefined, hardTimer: ReturnType<typeof setTimeout> | undefined;
      let waitingAuth = false;
      const clearDeadlines = () => {
        clearTimeout(timer);
        clearTimeout(hardTimer);
        hardTimer = undefined;
        waitingAuth = false;
      };
      const finish = () => {
        clearDeadlines();
        resolve();
      };
      const release = () => {
        lease?.send(['CLOSE', id]);
        lease?.release();
      };
      closers.push(() => {
        ended = true;
        finish();
        release();
      });
      const fail = (error: Error) => {
        if (ended || stopped) {
          return;
        }
        ended = true;
        clearDeadlines();
        release();
        if (initialComplete) {
          try {
            void Promise.resolve(onDisconnect?.(error)).catch(() => {
            });
          }
          catch {
          }
        }
        else {
          reject(error);
        }
      };
      const deadline = (auth = false) => {
        if (!hardTimer) {
          hardTimer = setTimeout(() => fail(new RelayError('Relay initial read deadline exceeded', {
            relay: url,
            operation: 'subscribe',
            code: 'RELAY_EOSE_TIMEOUT'
          })), Math.min(2147483647, this.timeouts.eoseTimeoutMs + this.timeouts.authTimeoutMs));
        }
        if (auth && waitingAuth) {
          return;
        }
        waitingAuth = auth;
        clearTimeout(timer);
        timer = setTimeout(() => fail(new RelayError(auth ? 'Relay authentication timeout' : 'Relay EOSE timeout', {
          relay: url,
          operation: auth ? 'auth' : 'subscribe',
          code: auth ? 'RELAY_AUTH_TIMEOUT' : 'RELAY_EOSE_TIMEOUT'
        })), auth ? this.timeouts.authTimeoutMs : this.timeouts.eoseTimeoutMs);
      };
      const request = () => {
        if (ended || stopped) {
          return;
        }
        live = false;
        if (lease?.authenticating) {
          deadline(true);
          return;
        }
        deadline();
        lease?.send(['REQ', id, filter]);
      };
      try {
        lease = this.pool.acquire(url, {
          failed: fail,
          authenticating: () => {
            if (!ended) {
              live = false;
              deadline(true);
            }
          },
          authenticated: request,
          message: msg => {
            if (ended || stopped || msg[1] !== id) {
              return;
            }
            if (msg[0] === 'EOSE' && !lease?.authenticating && !waitingAuth) {
              live = true;
              initialComplete = true;
              finish();
            }
            if (msg[0] === 'EVENT' && msg[2] && typeof msg[2] === 'object') {
              onEvent(msg[2] as Event, live ? 'live' : 'history');
            }
            if (msg[0] === 'CLOSED') {
              if (this.sign && typeof msg[2] === 'string' && msg[2].startsWith('auth-required:')) {
                live = false;
                deadline(true);
                return;
              }
              fail(new RelayError('Relay refused subscription', {
                relay: url,
                operation: 'subscribe',
                code: typeof msg[2] === 'string' && msg[2].startsWith('auth-required:') ? 'RELAY_AUTH_REQUIRED' : 'RELAY_SUBSCRIPTION_REJECTED',
                reason: typeof msg[2] === 'string' ? msg[2] : undefined
              }));
            }
          },
        });
        void lease.ready.then(request, fail);
      }
      catch (error) {
        fail(error instanceof RelayError ? error : new RelayError('Relay connection failed', {
          relay: url,
          operation: 'connect',
          code: 'RELAY_CONNECTION_FAILED'
        }));
      }
    }))).then(() => {
    });
    return {
      ready, close: () => {
        stopped = true;
        closers.forEach(close => close());
      }
    };
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
        sub = this.subscribe([relay], filter, (event, source) => {
          if (source === 'history') {
            events.push(event);
          }
        });
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
    // Preserve conflicting same-ID bodies for the caller's signature validation; never trust relay IDs here.
    return successful.flatMap(r => r.value);
  }

  async publish(relays: string[], event: Event): Promise<void> {
    if (!relays.length) {
      throw new Error('No delivery relays');
    }
    await Promise.any([...new Set(relays)].map(url => new Promise<void>((resolve, reject) => {
      const start = performance.now();
      let settled = false, waitingAuth = false, lease: RelayLease | undefined, timer: ReturnType<typeof setTimeout> | undefined, hardTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        lease?.release();
        this.timing('publish', url, [event.kind], start, error);
        error ? reject(error) : resolve();
      };
      const deadline = (auth = false) => {
        if (!hardTimer) {
          hardTimer = setTimeout(() => finish(new RelayError('Relay publication deadline exceeded', {
            relay: url,
            operation: 'publish',
            code: 'RELAY_ACK_TIMEOUT',
            eventKind: event.kind
          })), Math.min(2147483647, this.timeouts.publishTimeoutMs + this.timeouts.authTimeoutMs));
        }
        if (auth && waitingAuth) {
          return;
        }
        waitingAuth = auth;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new RelayError(auth ? 'Relay authentication timeout' : 'Relay ACK timeout', {
          relay: url,
          operation: auth ? 'auth' : 'publish',
          code: auth ? 'RELAY_AUTH_TIMEOUT' : 'RELAY_ACK_TIMEOUT',
          eventKind: event.kind
        })), auth ? this.timeouts.authTimeoutMs : this.timeouts.publishTimeoutMs);
      };
      const publish = () => {
        if (settled) {
          return;
        }
        if (lease?.authenticating) {
          deadline(true);
          return;
        }
        deadline();
        lease?.send(['EVENT', event]);
      };
      try {
        lease = this.pool.acquire(url, {
          failed: finish,
          authenticating: () => {
            if (!settled) {
              deadline(true);
            }
          },
          authenticated: publish,
          message: msg => {
            if (settled || msg[0] !== 'OK' || msg[1] !== event.id) {
              return;
            }
            if (msg[2] === true) {
              finish();
              return;
            }
            if (this.sign && typeof msg[3] === 'string' && msg[3].startsWith('auth-required:')) {
              deadline(true);
              return;
            }
            finish(new RelayError('Relay rejected event', {
              relay: url,
              operation: 'publish',
              code: typeof msg[3] === 'string' && msg[3].startsWith('auth-required:') ? 'RELAY_AUTH_REQUIRED' : 'RELAY_EVENT_REJECTED',
              eventKind: event.kind,
              reason: typeof msg[3] === 'string' ? msg[3] : undefined
            }));
          },
        });
        void lease.ready.then(publish, error => finish(error));
      }
      catch (error) {
        finish(error instanceof RelayError ? error : new RelayError('Relay connection failed', {
          relay: url,
          operation: 'connect',
          code: 'RELAY_CONNECTION_FAILED'
        }));
      }
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
