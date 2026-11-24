import type { Event } from "nostr-tools";
import { hexKey } from "./protocol.js";
import type { Store } from "./store.js";

/** Only authenticated metadata from messagingMetadata may enter this cache. */
export function recordPeerMetadata(store: Store, events: Event[]) {
  for (const event of events) {
    if (event.kind === 10044) {
      store.rememberDeclaration(event);
      const key = event.tags.find((t) => t[0] === "n")?.[1];
      if (hexKey(key)) {
        store.markSplitPeer(event.pubkey);
        store.observe(event.pubkey, key, event.created_at * 1000, event.id);
      }
    }
  }
}
