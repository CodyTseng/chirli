import WebSocket from 'ws';
import type { Event, EventTemplate } from 'nostr-tools';
import { RelayError } from './errors.js';

export interface RelayTimeouts {
  connectionTimeoutMs: number;
  eoseTimeoutMs: number;
  publishTimeoutMs: number;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export const DEFAULT_RELAY_TIMEOUTS: Readonly<RelayTimeouts> = Object.freeze({
  connectionTimeoutMs: 5000,
  eoseTimeoutMs: 25000,
  publishTimeoutMs: 5000,
  authTimeoutMs: 8000,
  idleTimeoutMs: 30000,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 10000,
});

interface Consumer {
  message(frame: unknown[]): void;
  failed(error: RelayError): void;
  authenticating(): void;
  authenticated(): void;
}

interface Connection {
  url: string;
  ws: WebSocket;
  ready: Promise<void>;
  users: Set<Consumer>;
  idle?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setTimeout>;
  pong?: ReturnType<typeof setTimeout>;
  authTimer?: ReturnType<typeof setTimeout>;
  authId?: string;
  challenge?: string;
  failed: boolean;
  fail(error: RelayError): void;
}

export interface RelayLease {
  readonly authenticating: boolean;
  ready: Promise<void>;
  send(frame: unknown[]): void;
  release(): void;
}

/** Physical connections only; durable subscription retries belong to InboxSubscription. */
export class RelayPool {
  private connections = new Map<string, Connection>();
  private closed = false;

  constructor(private timeouts: RelayTimeouts, private sign?: (template: EventTemplate) => Promise<Event>, private createSocket = (url: string) => new WebSocket(url, {
    maxPayload: 1024 * 1024
  })) {
  }

  acquire(url: string, consumer: Consumer): RelayLease {
    if (this.closed) {
      throw new RelayError('Relay pool closed', {
        relay: url,
        operation: 'connect',
        code: 'RELAY_CLOSED'
      });
    }
    // Preserve paths and query strings: they may carry routing or authentication information.
    const key = new URL(url).href;
    let connection = this.connections.get(key);
    if (!connection) {
      connection = this.connect(key);
      this.connections.set(key, connection);
    }
    const current = connection;
    clearTimeout(current.idle);
    current.idle = undefined;
    current.users.add(consumer);
    let released = false;
    return {
      get authenticating() {
        return current.authTimer !== undefined;
      },
      ready: current.ready,
      send: frame => {
        if (!released && !current.failed && current.ws.readyState === WebSocket.OPEN) {
          current.ws.send(JSON.stringify(frame));
        }
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        current.users.delete(consumer);
        if (current.users.size || current.failed) {
          return;
        }
        // A canceled handshake has no useful warm connection to retain.
        if (current.ws.readyState !== WebSocket.OPEN) {
          current.fail(this.closedError(key));
          return;
        }
        current.idle = setTimeout(() => current.fail(this.closedError(key)), this.timeouts.idleTimeoutMs);
        current.idle.unref();
      },
    };
  }

  private closedError(url: string) {
    return new RelayError('Relay disconnected', {
      relay: url,
      operation: 'subscribe',
      code: 'RELAY_CLOSED'
    });
  }

  private connect(url: string): Connection {
    const ws = this.createSocket(url);
    let resolve!: () => void, reject!: (error: RelayError) => void;
    const ready = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A caller can cancel before it starts awaiting the handshake.
    void ready.catch(() => {
    });
    const connection: Connection = {
      url,
      ws,
      ready,
      users: new Set(),
      failed: false,
      fail: () => {
      }
    };
    const timer = setTimeout(() => connection.fail(new RelayError('Relay connection timeout', {
      relay: url,
      operation: 'connect',
      code: 'RELAY_CONNECT_TIMEOUT'
    })), this.timeouts.connectionTimeoutMs);
    connection.fail = error => {
      if (connection.failed) {
        return;
      }
      connection.failed = true;
      clearTimeout(timer);
      clearTimeout(connection.idle);
      clearTimeout(connection.heartbeat);
      clearTimeout(connection.pong);
      clearTimeout(connection.authTimer);
      if (this.connections.get(url) === connection) {
        this.connections.delete(url);
      }
      reject(error);
      ws.terminate();
      for (const user of [...connection.users]) {
        try {
          user.failed(error);
        }
        catch {
        }
      }
      connection.users.clear();
    };
    const heartbeat = () => {
      clearTimeout(connection.heartbeat);
      connection.heartbeat = setTimeout(() => {
        if (connection.failed) {
          return;
        }
        connection.pong = setTimeout(() => connection.fail(this.closedError(url)), this.timeouts.heartbeatTimeoutMs);
        connection.pong.unref();
        ws.ping();
      }, this.timeouts.heartbeatIntervalMs);
      connection.heartbeat.unref();
    };
    ws.on('pong', () => {
      clearTimeout(connection.pong);
      heartbeat();
    });
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
      heartbeat();
    });
    ws.on('error', error => connection.fail(new RelayError('Relay connection failed', {
      relay: url,
      operation: 'connect',
      code: 'RELAY_CONNECTION_FAILED',
      networkCode: (error as NodeJS.ErrnoException).code
    })));
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      connection.fail(new RelayError('Relay HTTP handshake rejected', {
        relay: url,
        operation: 'connect',
        code: 'RELAY_HTTP_REJECTED',
        statusCode: response.statusCode
      }));
    });
    ws.on('close', closeCode => connection.fail(new RelayError('Relay disconnected', {
      relay: url,
      operation: 'subscribe',
      code: 'RELAY_CLOSED',
      closeCode
    })));
    ws.on('message', raw => {
      if (connection.failed) {
        return;
      }
      let frame: unknown[];
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!Array.isArray(parsed)) {
          return;
        }
        frame = parsed;
      }
      catch {
        return;
      }
      if (frame[0] === 'AUTH' && typeof frame[1] === 'string' && this.sign && connection.users.size) {
        const challenge = frame[1];
        if (connection.challenge === challenge) {
          return;
        }
        connection.challenge = challenge;
        connection.authId = undefined;
        for (const user of [...connection.users]) {
          user.authenticating();
        }
        // New challenges cannot renew an in-progress authentication budget.
        connection.authTimer ??= setTimeout(() => connection.fail(new RelayError('Relay authentication timeout', {
          relay: url,
          operation: 'auth',
          code: 'RELAY_AUTH_TIMEOUT'
        })), this.timeouts.authTimeoutMs);
        void Promise.resolve().then(() => this.sign!({
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['relay', url], ['challenge', challenge]],
          content: ''
        })).then(event => {
          if (connection.failed || connection.challenge !== challenge) {
            return;
          }
          connection.authId = event.id;
          ws.send(JSON.stringify(['AUTH', event]));
        }).catch(() => {
          if (!connection.failed && connection.challenge === challenge) {
            connection.fail(new RelayError('Relay authentication signing failed', {
              relay: url,
              operation: 'auth',
              code: 'RELAY_AUTH_SIGNING_FAILED'
            }));
          }
        });
        return;
      }
      if (frame[0] === 'OK' && connection.authId !== undefined && frame[1] === connection.authId) {
        connection.authId = undefined;
        clearTimeout(connection.authTimer);
        connection.authTimer = undefined;
        if (frame[2] !== true) {
          connection.fail(new RelayError('Relay authentication rejected', {
            relay: url,
            operation: 'auth',
            code: 'RELAY_AUTH_REJECTED',
            reason: typeof frame[3] === 'string' ? frame[3] : undefined
          }));
          return;
        }
        for (const user of [...connection.users]) {
          user.authenticated();
        }
        return;
      }
      for (const user of [...connection.users]) {
        try {
          user.message(frame);
        }
        catch { /* Isolate subscription callbacks. */
        }
      }
    });
    return connection;
  }

  close() {
    this.closed = true;
    for (const connection of [...this.connections.values()]) {
      connection.fail(this.closedError(connection.url));
    }
  }
}
