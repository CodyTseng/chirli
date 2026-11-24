import { verifyEvent, type Event, type Filter } from "nostr-tools";
import {
  AbstractSimplePool,
  type SubscribeManyParams,
} from "nostr-tools/abstract-pool";
import { websocketURL } from "../metadata.js";
import {
  DEFAULT_RELAY_TIMEOUTS,
  WebSocketTransport,
  subscribeRequests,
  type Subscription,
} from "../relay.js";

export function bunkerRelayURLs(values: string[]): string[] {
  if (!Array.isArray(values) || !values.length)
    throw new TypeError("At least one bunker relay is required");
  if (!Array.from(values).every(websocketURL))
    throw new TypeError("Invalid bunker relay URL");
  return [...new Set(values.map((value) => new URL(value).href))];
}

/** Bridge the two pool operations used by nostr-tools' BunkerSigner. */
export class BunkerRelayPool extends AbstractSimplePool {
  private readonly transport: WebSocketTransport;
  private readonly subscriptionClosers = new Set<() => void>();
  private current?: (url: string, event: Event) => Promise<string>;

  constructor(timeoutMs: number) {
    super({ verifyEvent, maxWaitForConnection: timeoutMs });
    this.transport = new WebSocketTransport({
      connectionTimeoutMs: timeoutMs,
      publishTimeoutMs: Math.min(
        timeoutMs,
        DEFAULT_RELAY_TIMEOUTS.publishTimeoutMs,
      ),
    });
  }

  override subscribe(
    relays: string[],
    filter: Filter,
    params: SubscribeManyParams,
  ) {
    const urls = bunkerRelayURLs(relays);
    const subscriptions = new Map<string, Subscription>();
    const reasons = new Map<string, string>();
    let closed = false;
    const close = () => {
      closed = true;
      this.subscriptionClosers.delete(close);
      if (this.current === publish) this.current = undefined;
      for (const sub of subscriptions.values()) sub.close();
      subscriptions.clear();
    };
    const open = (url: string) => {
      const failed = (error: Error) => {
        if (subscriptions.get(url) !== sub) return;
        sub.close();
        subscriptions.delete(url);
        reasons.set(url, error.message);
        if (!subscriptions.size) {
          close();
          params.onclose?.(
            urls.map((url) => ({
              url,
              reason: reasons.get(url) ?? "Subscription closed",
            })),
          );
        }
      };
      const sub = subscribeRequests(
        this.transport,
        [url],
        filter,
        (event) => params.onevent?.(event),
        failed,
      );
      subscriptions.set(url, sub);
      void sub.ready.catch(failed);
      return sub;
    };
    const publish = async (url: string, event: Event) => {
      if (closed || !urls.includes(url))
        throw new Error("Bunker subscription unavailable");
      const sub = subscriptions.get(url) ?? open(url);
      await sub.ready;
      if (subscriptions.get(url) !== sub)
        throw new Error("Bunker subscription unavailable");
      await this.transport.publish([url], event);
      return "";
    };
    for (const url of urls) open(url);
    this.subscriptionClosers.add(close);
    this.current = publish;
    return { close };
  }

  override publish(relays: string[], event: Event): Promise<string>[] {
    const publish = this.current;
    return bunkerRelayURLs(relays).map(async (url) => {
      if (!publish) throw new Error("Bunker subscription unavailable");
      return publish(url, event);
    });
  }

  override destroy() {
    for (const close of this.subscriptionClosers) close();
    this.transport.close();
  }
}
