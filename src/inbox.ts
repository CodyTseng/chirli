import { RelayError } from "./errors.js";
import { verifyEvent, type Event, type Filter } from "nostr-tools";
import {
  physicalConnectionState,
  subscribeInbox,
  type Subscription,
  type Transport,
} from "./relay.js";
import type { Store } from "./store.js";
import { validTimestamp } from "./protocol.js";

export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  stableResetMs?: number;
}

export interface RecoveryOptions {
  pageSize?: number;
  maxPages?: number;
  overlapSeconds?: number;
}

export interface HistorySyncResult {
  relay: string;
  coverage: "window";
  since: number;
  until: number;
  pages: number;
  status: "window-complete" | "incomplete" | "aborted" | "disabled";
  reason?: "page-limit" | "boundary-overflow" | "query-failed";
}

interface Attempt {
  subscription?: Subscription;
  query?: Subscription;
  canceled: Promise<void>;
  cancel(): void;
}

interface Replica {
  url: string;
  attempt?: Attempt;
  retry?: ReturnType<typeof setTimeout>;
  failures: number;
  stable?: ReturnType<typeof setTimeout>;
  connectedBefore: boolean;
  outageTimer?: ReturnType<typeof setTimeout>;
  outageError?: RelayError;
  outageReported?: boolean;
  initial: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  recovering?: Promise<HistorySyncResult>;
  recoveringAttempt?: Attempt;
}

function integer(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

/** Headless per-relay demand, generation cancellation and fixed-window catch-up. */
export class InboxSubscription implements Subscription {
  readonly ready: Promise<void>;
  private closed = false;
  private replicas: Replica[] = [];
  private retry?: {
    initial: number;
    max: number;
    jitter: number;
    stepped: boolean;
    stableReset: number;
  };
  private recovery?: {
    pageSize: number;
    maxPages: number;
    overlap: number;
  };

  constructor(
    private options: {
      transport: Transport;
      store: Store;
      relays: string[];
      filter: Filter;
      reconnect?: false | ReconnectOptions;
      recovery?: false | RecoveryOptions;
      /** Activation date in seconds is the baseline until this relay completes a pass. */
      recoveryBaseline?: number;
      localReadWindow?: boolean;
      receive(
        event: Event,
        source: "live" | "history",
        relay: string,
      ): void | Promise<void>;
      error(error: unknown): void;
      reconnected(): Promise<void>;
    },
  ) {
    if (options.reconnect !== false) {
      const initial = integer(
        options.reconnect?.initialDelayMs ?? 1000,
        "initialDelayMs",
        1,
        60000,
      );
      const max = integer(
        options.reconnect?.maxDelayMs ?? 60000,
        "maxDelayMs",
        initial,
        3600000,
      );
      const jitter = options.reconnect?.jitter ?? 0.2;
      if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
        throw new TypeError("jitter must be in 0..1");
      }
      this.retry = {
        initial,
        max,
        jitter,
        stepped: options.reconnect?.initialDelayMs === undefined,
        stableReset: integer(
          options.reconnect?.stableResetMs ?? 30000,
          "stableResetMs",
          1,
          3600000,
        ),
      };
    }
    if (options.recovery !== false) {
      this.recovery = {
        pageSize: integer(
          options.recovery?.pageSize ?? 500,
          "pageSize",
          1,
          1000,
        ),
        maxPages: integer(
          options.recovery?.maxPages ?? 20,
          "maxPages",
          1,
          1000,
        ),
        overlap: integer(
          options.recovery?.overlapSeconds ?? 176400,
          "overlapSeconds",
          172800,
          31536000,
        ),
      };
    }
    for (const url of new Set(options.relays)) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const initial = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      this.replicas.push({
        url,
        failures: 0,
        connectedBefore: false,
        initial,
        resolve,
        reject,
      });
    }
    this.ready = (
      this.replicas.length === 1
        ? this.replicas[0].initial
        : Promise.any(this.replicas.map((replica) => replica.initial))
    ).then(() => {});
    for (const replica of this.replicas) {
      this.connect(replica);
    }
  }

  /** An unfailed owned subscription, not physical connection success or historical EOSE. */
  hasUsableSubscription(): boolean {
    return (
      !this.closed &&
      this.replicas.some(
        (replica) =>
          replica.attempt?.subscription !== undefined &&
          physicalConnectionState(this.options.transport, replica.url) !==
            false,
      )
    );
  }

  private current(replica: Replica, attempt: Attempt) {
    return !this.closed && replica.attempt === attempt;
  }

  private connect(replica: Replica) {
    if (this.closed) {
      return;
    }
    let cancel!: () => void;
    const attempt: Attempt = {
      canceled: new Promise<void>((resolve) => {
        cancel = resolve;
      }),
      cancel: () => cancel(),
    };
    replica.attempt = attempt;
    const reconnecting = replica.connectedBefore || replica.failures > 0;
    const fail = (error: unknown) => {
      if (!this.current(replica, attempt)) {
        return;
      }
      replica.attempt = undefined;
      clearTimeout(replica.stable);
      replica.stable = undefined;
      attempt.cancel();
      attempt.subscription?.close();
      attempt.query?.close();
      const diagnostic =
        error instanceof RelayError
          ? error
          : new RelayError("Relay subscription failed", {
              relay: replica.url,
              operation: "subscribe",
              code: "RELAY_SUBSCRIPTION_FAILED",
            });
      // Established connections get a grace period for automatic network recovery.
      const transient = new Set([
        "RELAY_CONNECTION_FAILED",
        "RELAY_CONNECT_TIMEOUT",
        "RELAY_EOSE_TIMEOUT",
        "RELAY_CLOSED",
        "RELAY_SUBSCRIPTION_FAILED",
      ]);
      if (
        this.retry &&
        replica.connectedBefore &&
        transient.has(diagnostic.code)
      ) {
        replica.outageError = diagnostic;
        if (!replica.outageTimer && !replica.outageReported) {
          replica.outageTimer = setTimeout(() => {
            replica.outageTimer = undefined;
            if (!this.closed && replica.outageError) {
              replica.outageReported = true;
              this.options.error(replica.outageError);
            }
          }, 30000);
        }
      } else {
        this.options.error(diagnostic);
      }
      if (!replica.connectedBefore) {
        replica.reject(error);
      }
      if (!this.retry) {
        replica.reject(error);
        return;
      }
      const steps = [1000, 2000, 5000, 10000, 20000, 30000, 60000];
      const attemptIndex = replica.failures++;
      const base = Math.min(
        this.retry.max,
        this.retry.stepped
          ? steps[Math.min(attemptIndex, steps.length - 1)]
          : this.retry.initial * 2 ** Math.min(attemptIndex, 30),
      );
      const delay = Math.min(
        this.retry.max,
        Math.max(
          1,
          Math.round(
            base *
              (1 - this.retry.jitter + Math.random() * this.retry.jitter * 2),
          ),
        ),
      );
      replica.retry = setTimeout(() => {
        replica.retry = undefined;
        this.connect(replica);
      }, delay);
    };
    try {
      const subscription = (
        this.options.localReadWindow
          ? subscribeInbox.bind(undefined, this.options.transport)
          : this.options.transport.subscribe.bind(this.options.transport)
      )(
        [replica.url],
        this.options.filter,
        (event, source) => {
          if (this.current(replica, attempt)) {
            void Promise.resolve(
              this.options.receive(event, source, replica.url),
            ).catch((error) => this.options.error(error));
          }
        },
        fail,
      );
      attempt.subscription = subscription;
      if (!this.current(replica, attempt)) {
        subscription.close();
        return;
      }
      void subscription.ready
        .then(async () => {
          if (!this.current(replica, attempt)) {
            return;
          }
          replica.connectedBefore = true;
          // A brief EOSE followed by another drop must not restart a tight retry loop.
          if (this.retry) {
            replica.stable = setTimeout(() => {
              replica.stable = undefined;
              if (this.current(replica, attempt)) {
                replica.failures = 0;
              }
            }, this.retry.stableReset);
          }
          await this.recover(replica, attempt);
          if (!this.current(replica, attempt)) {
            return;
          }
          clearTimeout(replica.outageTimer);
          replica.outageTimer = undefined;
          replica.outageError = undefined;
          replica.outageReported = false;
          replica.resolve();
          if (reconnecting) {
            void this.options
              .reconnected()
              .catch((error) => this.options.error(error));
          }
        })
        .catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  private recover(
    replica: Replica,
    attempt: Attempt,
  ): Promise<HistorySyncResult> {
    if (replica.recovering && replica.recoveringAttempt === attempt) {
      return replica.recovering;
    }
    if (replica.recovering) {
      return replica.recovering.then(() => {
        if (!this.current(replica, attempt)) {
          return this.result(replica.url, "aborted");
        }
        return this.recover(replica, attempt);
      });
    }
    const task = this.scan(replica, attempt).finally(() => {
      if (replica.recovering === task) {
        replica.recovering = undefined;
      }
    });
    replica.recovering = task;
    replica.recoveringAttempt = attempt;
    return task;
  }

  private result(
    relay: string,
    status: HistorySyncResult["status"],
  ): HistorySyncResult {
    return {
      relay,
      coverage: "window",
      since: 0,
      until: 0,
      pages: 0,
      status,
    };
  }

  private async scan(
    replica: Replica,
    attempt: Attempt,
  ): Promise<HistorySyncResult> {
    const config = this.recovery;
    if (!config) {
      return this.result(replica.url, "disabled");
    }
    const through = Math.floor(Date.now() / 1000);
    const since = Math.max(
      0,
      Math.min(
        this.options.store.checkpoint(replica.url) ??
          this.options.recoveryBaseline ??
          through,
        through,
      ) - config.overlap,
    );
    let until = through;
    const result: HistorySyncResult = {
      relay: replica.url,
      coverage: "window",
      since,
      until: through,
      pages: 0,
      status: "incomplete",
    };
    const incomplete = (reason: HistorySyncResult["reason"]) => {
      result.reason = reason;
      this.options.error(
        new RelayError(
          `Inbox history recovery incomplete (${reason}); checkpoint unchanged`,
          {
            relay: replica.url,
            operation: "history",
            code: "RELAY_HISTORY_INCOMPLETE",
            historyReason: reason,
          },
        ),
      );
      return result;
    };
    try {
      while (this.current(replica, attempt) && result.pages < config.maxPages) {
        const events: Event[] = [];
        const sub = this.options.transport.subscribe(
          [replica.url],
          {
            ...this.options.filter,
            since,
            until,
            limit: config.pageSize,
          },
          (event, source) => {
            if (source === "history" && this.current(replica, attempt)) {
              events.push(event);
            }
          },
        );
        attempt.query = sub;
        try {
          await Promise.race([sub.ready, attempt.canceled]);
        } finally {
          sub.close();
          if (attempt.query === sub) {
            attempt.query = undefined;
          }
        }
        if (!this.current(replica, attempt)) {
          return {
            ...result,
            status: "aborted",
          };
        }
        const page = [
          ...new Map(
            events
              .filter((event) => {
                try {
                  return (
                    event.kind === 1059 &&
                    validTimestamp(event.created_at) &&
                    event.created_at >= since &&
                    event.created_at <= until &&
                    event.tags.some(
                      (tag) =>
                        tag[0] === "p" &&
                        tag[1] === this.options.filter["#p"]?.[0],
                    ) &&
                    verifyEvent(JSON.parse(JSON.stringify(event)))
                  );
                } catch {
                  return false;
                }
              })
              .map((event) => [event.id, event]),
          ).values(),
        ].sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
        result.pages++;
        for (const event of page) {
          if (!this.current(replica, attempt)) {
            return {
              ...result,
              status: "aborted",
            };
          }
          await this.options.receive(event, "history", replica.url);
        }
        if (!this.current(replica, attempt)) {
          return {
            ...result,
            status: "aborted",
          };
        }
        if (page.length < config.pageSize) {
          this.options.store.saveCheckpoint(replica.url, through);
          return {
            ...result,
            status: "window-complete",
          };
        }
        const oldest = page.at(-1)?.created_at;
        if (oldest === undefined || oldest >= until) {
          return incomplete("boundary-overflow");
        }
        until = oldest; // Inclusive boundary: re-read it before moving to an earlier second.
        await new Promise<void>((resolve) => setTimeout(resolve, 0)); // Yield between bounded crypto/SQLite pages.
      }
      return this.current(replica, attempt)
        ? incomplete("page-limit")
        : {
            ...result,
            status: "aborted",
          };
    } catch (error) {
      if (!this.current(replica, attempt)) {
        return {
          ...result,
          status: "aborted",
        };
      }
      this.options.error(error);
      return incomplete("query-failed");
    }
  }

  async sync(): Promise<HistorySyncResult[]> {
    await this.ready;
    return Promise.all(
      this.replicas.map((replica) =>
        replica.attempt
          ? this.recover(replica, replica.attempt)
          : this.result(replica.url, "aborted"),
      ),
    );
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const replica of this.replicas) {
      clearTimeout(replica.retry);
      clearTimeout(replica.outageTimer);
      clearTimeout(replica.stable);
      replica.attempt?.cancel();
      replica.attempt?.subscription?.close();
      replica.attempt?.query?.close();
      replica.attempt = undefined;
      clearTimeout(replica.stable);
      replica.stable = undefined;
      replica.resolve();
    }
  }
}
