import { verifyEvent, type Event } from "nostr-tools";
import {
  hexKey,
  signChecked,
  validTimestamp,
  type Identity,
} from "./protocol.js";
import type { Transport } from "./relay.js";

export async function messagingMetadata(
  peer: string,
  kinds: number[],
  transport: Transport,
  relays: string[],
): Promise<Event[]> {
  if (!hexKey(peer)) {
    throw new Error("Invalid peer identity");
  }
  const events = await transport.query(relays, {
    kinds,
    authors: [peer],
  });
  return events
    .filter((event) => {
      try {
        return (
          kinds.includes(event.kind) &&
          event.pubkey === peer &&
          validTimestamp(event.created_at) &&
          verifyEvent(JSON.parse(JSON.stringify(event)))
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
}

export function websocketURL(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      ["ws:", "wss:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function standardRelays(events: Event[]): string[] {
  const latest = events.find((event) => event.kind === 10050);
  const relays = [
    ...new Set(
      latest?.tags
        .filter((tag) => tag[0] === "relay" && websocketURL(tag[1]))
        .map((tag) => tag[1]) ?? [],
    ),
  ];
  if (!relays.length) {
    throw new Error(
      "nip17 requires a valid recipient kind 10050 DM relay list; no relay fallback",
    );
  }
  return relays;
}

export function relayAnnouncement(
  identity: Identity,
  relays: string[],
): Promise<Event> {
  if (!relays.length || !relays.every(websocketURL)) {
    throw new Error("nip17 requires valid WebSocket inbox relay URLs");
  }
  return signChecked(identity, {
    kind: 10050,
    created_at: Math.floor(Date.now() / 1000),
    tags: [...new Set(relays)].map((relay) => ["relay", relay]),
    content: "",
  });
}
