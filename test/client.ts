import { Client as PublicClient, type ClientOptions } from "../src/client.js";
import { after } from "node:test";
import type { Transport } from "../src/relay.js";
import type { Store } from "../src/store.js";
import type { Identity } from "../src/protocol.js";

type FixtureOptions<T> = T extends unknown
  ? Omit<T, "signer" | "identity"> & { identity: Identity }
  : never;

// This test fixture owns injected transports; the SDK only releases its subscriptions.
const transports = new Set<Transport>();
after(() => {
  for (const transport of transports) transport.close();
});

/** Internal protocol fixtures only. Application tests use PublicClient.create({ signer }). */
export const Client = new Proxy(PublicClient, {
  construct(target, args) {
    const options = args[0];
    if (options.transport) transports.add(options.transport);
    const client = Reflect.construct(target, args);
    Object.defineProperty(client, "store", {
      get: () => Reflect.get(client, "coreStore"),
    });
    return client;
  },
}) as unknown as Omit<typeof PublicClient, "prototype"> & {
  new (options: FixtureOptions<ClientOptions>): Client;
};
export type Client = PublicClient & { readonly store: Store };
