import assert from "node:assert/strict";
import { matchFilter, verifyEvent, type Event, type Filter } from "nostr-tools";
import {
  Bot,
  generateSecretKey,
  nsecSigner,
  type ProtocolMode,
  type Input,
  type Subscription,
  type Transport,
} from "chirli";

/** Demo-only relay substitute: no sockets, filesystem, credentials, or external services. */
export class MemoryRelay {
  private events = new Map<string, Event>();
  private listeners = new Set<{
    filter: Filter;
    receive(event: Event, source: "live" | "history"): void;
  }>();

  transport(): Transport {
    const owned = new Set<() => void>();
    const query = (filter: Filter) =>
      [...this.events.values()]
        .filter((event) => matchFilter(filter, event))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, filter.limit ?? Number.MAX_SAFE_INTEGER);
    return {
      query: async (_relays, filter) => structuredClone(query(filter)),
      subscribe: (_relays, filter, receive): Subscription => {
        const listener = { filter, receive };
        // Synchronous history/live handoff is safe here because this relay has no I/O.
        for (const event of query(filter))
          receive(structuredClone(event), "history");
        this.listeners.add(listener);
        const close = () => {
          this.listeners.delete(listener);
          owned.delete(close);
        };
        owned.add(close);
        return { ready: Promise.resolve(), close };
      },
      publish: async (_relays, event) => {
        const copy: Event = structuredClone(event);
        if (!verifyEvent(copy))
          throw new Error("Demo relay rejected invalid signature");
        if (this.events.has(copy.id)) return;
        this.events.set(copy.id, copy);
        for (const listener of this.listeners) {
          if (matchFilter(listener.filter, copy))
            listener.receive(structuredClone(copy), "live");
        }
      },
      close: () => {
        for (const close of owned) close();
      },
    };
  }
}

/** Common setup stays here so each demo focuses on its application handler. */
export function createDemo<S = Record<string, unknown>>(
  mode: ProtocolMode = "nip17",
) {
  const relay = new MemoryRelay();
  const userSigner = nsecSigner(generateSecretKey()),
    serviceSigner = nsecSigner(generateSecretKey());
  const transports = [relay.transport(), relay.transport()];
  const createBot = (signer: typeof userSigner, transport: Transport) =>
    new Bot<S>({
      mode,
      signer,
      storageKey: generateSecretKey(),
      database: ":memory:",
      relays: ["wss://demo.invalid"], // Identifier only; MemoryRelay never connects to it.
      transport,
    });
  const user = createBot(userSigner, transports[0]);
  const service = createBot(serviceSigner, transports[1]);
  const failures: unknown[] = [],
    replies: Input[] = [];
  user.onError((error) => {
    failures.push(error);
  });
  service.onError((error) => {
    failures.push(error);
  });
  user.handle(({ input }) => {
    replies.push(input);
  });
  const check = () => {
    if (failures.length)
      throw new AggregateError(failures, "Demo handler failed");
  };
  return {
    user,
    service,
    async start() {
      await user.start();
      await service.start();
      check();
    },
    async request(text: string): Promise<string> {
      const before = replies.length;
      const result = await user.send(service.pubkey, text);
      assert.equal(result.status, "relay-accepted");
      await service.idle();
      await user.idle();
      check();
      assert.equal(
        replies.length,
        before + 1,
        "Each scripted request expects exactly one reply",
      );
      return replies[before].text;
    },
    async close() {
      const results = await Promise.allSettled([service.close(), user.close()]);
      for (const transport of transports) transport.close();
      await Promise.all([serviceSigner.close(), userSigner.close()]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, "Demo cleanup failed");
    },
  };
}
