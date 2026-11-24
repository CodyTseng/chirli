import {
  matchFilter,
  verifyEvent,
  type Event,
  type EventTemplate,
  type Filter,
} from "nostr-tools";
import { decode } from "nostr-tools/nip19";
import { hexKey, validTimestamp, type Rumor } from "./protocol.js";
import type { Transport } from "./relay.js";
export interface Input {
  readonly id: string;
  readonly sender: string;
  readonly createdAt: number;
  readonly text: string;
  readonly event: Event | Rumor;
}
export interface ThreadResult {
  entries: Input[];
  complete: boolean;
  coverage: "local-conversation" | "public-ancestors";
  reason?: string;
}
export interface ThreadOptions {
  limit?: number;
}
export interface PublicThreadOptions {
  timeoutMs?: number;
  maxEvents?: number;
  maxLookups?: number;
  maxDepth?: number;
}
export interface RootReference {
  id?: string;
  address?: string;
  external?: string;
  kind?: string;
  author?: string;
  hint?: string;
}
export interface ThreadStructure {
  root?: RootReference;
  parent?: RootReference;
  explicitRoot: boolean;
}
export const inputOf = (event: Event | Rumor): Input => ({
  id: event.id,
  sender: event.pubkey,
  createdAt: event.created_at,
  text: event.content,
  event: structuredClone(event),
});
export function publicEvent(input: Event): Event | undefined {
  try {
    const event: Event = structuredClone(input);
    return ![13, 14, 1059].includes(event.kind) &&
      validTimestamp(event.created_at) &&
      verifyEvent(event)
      ? event
      : undefined;
  } catch {
    return;
  }
}
const coordinate = (value: string) => {
  const match = /^(\d+):([0-9a-f]{64}):([\s\S]*)$/.exec(value);
  if (!match || Number(match[1]) > 65535 || value.length > 4096)
    throw new Error("Malformed thread address");
  const kind = Number(match[1]);
  if (
    !(
      kind === 0 ||
      kind === 3 ||
      (kind >= 10000 && kind < 20000) ||
      (kind >= 30000 && kind < 40000)
    )
  )
    throw new Error("Thread address is not replaceable");
  return { kind, pubkey: match[2], identifier: match[3] };
};
export function eventCoordinate(event: Event): string | undefined {
  if (event.kind >= 30000 && event.kind < 40000)
    return `${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;
  if (
    event.kind === 0 ||
    event.kind === 3 ||
    (event.kind >= 10000 && event.kind < 20000)
  )
    return `${event.kind}:${event.pubkey}:`;
}
export const referenceKey = (ref: RootReference) =>
  ref.address
    ? `a:${ref.address}`
    : ref.id
      ? `e:${ref.id}`
      : `i:${ref.external}`;
const selfReference = (event: Event): RootReference => ({
  id: event.id,
  ...(eventCoordinate(event) ? { address: eventCoordinate(event) } : {}),
  kind: String(event.kind),
  author: event.pubkey,
});
function singleton(event: Event, name: string) {
  const tags = event.tags.filter((t) => t[0] === name);
  if (tags.length > 1) throw new Error(`Ambiguous thread ${name}`);
  return tags[0];
}
function modernReference(event: Event, upper: boolean): RootReference {
  const id = singleton(event, upper ? "E" : "e"),
    address = singleton(event, upper ? "A" : "a"),
    external = singleton(event, upper ? "I" : "i"),
    kind = singleton(event, upper ? "K" : "k")?.[1];
  if (!kind || (!id && !address && !external) || (external && (id || address)))
    throw new Error("Missing or conflicting thread reference");
  if (id && !hexKey(id[1])) throw new Error("Malformed thread event ID");
  const point = address ? coordinate(address[1]) : undefined;
  if (point && String(point.kind) !== kind)
    throw new Error("Thread address kind mismatch");
  if (!external && !/^\d+$/.test(kind)) throw new Error("Invalid thread kind");
  if (
    !external &&
    (!Number.isSafeInteger(Number(kind)) || Number(kind) > 65535)
  )
    throw new Error("Invalid thread kind");
  const authors = event.tags
    .filter((t) => t[0] === (upper ? "P" : "p"))
    .map((t) => t[1])
    .filter(hexKey);
  if (upper && authors.length !== 1 && !external)
    throw new Error("Missing root author");
  const hintAuthor = id?.[3];
  if (hintAuthor && !hexKey(hintAuthor))
    throw new Error("Invalid thread author");
  const author =
    point?.pubkey ??
    hintAuthor ??
    (authors.length === 1 ? authors[0] : undefined);
  if (upper && !external && (!author || authors[0] !== author))
    throw new Error("Conflicting root author");
  if (point && hintAuthor && point.pubkey !== hintAuthor)
    throw new Error("Conflicting address author");
  if (external && (!external[1] || external[1].length > 4096))
    throw new Error("Invalid external scope");
  return {
    ...(id ? { id: id[1] } : {}),
    ...(address ? { address: address[1] } : {}),
    ...(external ? { external: external[1] } : {}),
    kind,
    author,
    hint: (address ?? id ?? external)?.[2],
  };
}
export function threadStructure(event: Event): ThreadStructure {
  if (event.kind === 1111)
    return {
      root: modernReference(event, true),
      parent: modernReference(event, false),
      explicitRoot: true,
    };
  if (event.kind !== 1)
    return { root: selfReference(event), explicitRoot: true };
  const quotes = new Set<string>();
  for (const match of event.content.matchAll(
    /(?:nostr:)?((?:note1|nevent1|naddr1)[0-9a-z]+)/g,
  ))
    try {
      const value = decode(match[1]);
      if (value.type === "note") quotes.add(value.data);
      if (value.type === "nevent") quotes.add(value.data.id);
      if (value.type === "naddr")
        quotes.add(
          `${value.data.kind}:${value.data.pubkey}:${value.data.identifier}`,
        );
    } catch {}
  const tags = event.tags.filter(
    (t) =>
      (t[0] === "e" || t[0] === "a") &&
      t[3] !== "mention" &&
      (t[3] === "root" ||
        t[3] === "reply" ||
        (!t[3] && t[0] === "e" && !quotes.has(t[1]))),
  );
  const roots = tags.filter((t) => t[3] === "root"),
    parents = tags.filter((t) => t[3] === "reply"),
    positional = tags.filter((t) => !t[3]);
  if (roots.length > 1 || parents.length > 1)
    throw new Error("Ambiguous legacy thread markers");
  const root = roots[0] ?? positional[0],
    parent = parents[0] ?? positional.at(-1) ?? root;
  const ref = (tag: string[]): RootReference => {
    if (tag[0] === "a") {
      const value = coordinate(tag[1]);
      return {
        address: tag[1],
        kind: String(value.kind),
        author: value.pubkey,
        hint: tag[2],
      };
    }
    if (!hexKey(tag[1]) || (tag[4] && !hexKey(tag[4])))
      throw new Error("Malformed legacy thread reference");
    return { id: tag[1], author: tag[4] || undefined, hint: tag[2] };
  };
  return {
    root: root ? ref(root) : undefined,
    parent: parent ? ref(parent) : undefined,
    explicitRoot: roots.length > 0,
  };
}
function matches(ref: RootReference, event: Event) {
  return (
    (!ref.id || ref.id === event.id) &&
    (!ref.address || ref.address === eventCoordinate(event)) &&
    (!ref.kind || ref.kind === String(event.kind)) &&
    (!ref.author || ref.author === event.pubkey)
  );
}
export function threadLimit(limit = 30) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("thread limit must be in 1..100");
  return limit;
}
/** Bounded root-batched graph, followed only along the trigger's ancestor path. */
export class PublicThreads {
  readonly timeout: number;
  readonly maxEvents: number;
  readonly maxLookups: number;
  readonly maxDepth: number;
  constructor(
    private transport: Transport,
    private relays: string[],
    options: PublicThreadOptions = {},
  ) {
    this.timeout = options.timeoutMs ?? 3000;
    this.maxEvents = options.maxEvents ?? 500;
    this.maxLookups = options.maxLookups ?? 16;
    this.maxDepth = options.maxDepth ?? 64;
    for (const [name, value, min, max] of [
      ["timeoutMs", this.timeout, 1, 30000],
      ["maxEvents", this.maxEvents, 1, 2000],
      ["maxLookups", this.maxLookups, 1, 64],
      ["maxDepth", this.maxDepth, 1, 256],
    ] as const)
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new TypeError(`Invalid public thread ${name}`);
  }
  private budget() {
    const deadline = performance.now() + this.timeout;
    let lookups = 0;
    let bounded = false;
    return {
      get bounded() {
        return bounded;
      },
      query: async (filter: Filter) => {
        if (++lookups > this.maxLookups) throw new Error("lookup-limit");
        const left = deadline - performance.now();
        if (left <= 0) throw new Error("timeout");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const events = await Promise.race([
            this.transport.query(this.relays, {
              ...filter,
              limit: this.maxEvents,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), left);
            }),
          ]);
          if (events.length >= this.maxEvents) bounded = true;
          return events.flatMap((frame) => {
            const event = publicEvent(frame);
            return event && matchFilter(filter, event) ? [event] : [];
          });
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
  private filter(ref: RootReference): Filter | undefined {
    if (ref.id) return { ids: [ref.id] };
    if (ref.address) {
      const c = coordinate(ref.address);
      return {
        authors: [c.pubkey],
        kinds: [c.kind],
        ...(c.kind >= 30000 ? { "#d": [c.identifier] } : {}),
      };
    }
    if (ref.id) return { ids: [ref.id] };
  }
  async rootForReply(trigger: Event): Promise<RootReference> {
    const budget = this.budget(),
      visited = new Set<string>();
    let current = trigger;
    for (let depth = 0; depth < this.maxDepth; depth++) {
      if (visited.has(current.id)) throw new Error("Cyclic public thread");
      visited.add(current.id);
      const structure = threadStructure(current);
      if (current.kind === 1111) {
        if (!structure.root) throw new Error("Missing public thread root");
        return structure.root;
      }
      if (!structure.parent) return selfReference(current);
      const ref = structure.explicitRoot ? structure.root : structure.parent;
      if (!ref) throw new Error("Missing public thread root");
      const filter = this.filter(ref);
      if (!filter) throw new Error("Unresolved public root");
      const events = (await budget.query(filter))
        .filter((event) => matches(ref, event))
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      if (!events[0]) throw new Error("Missing public thread root");
      current = events[0];
      if (structure.explicitRoot) {
        const parsed = threadStructure(current);
        if (parsed.parent && current.kind === 1)
          throw new Error("Conflicting legacy root");
        if (current.kind === 1111) {
          if (!parsed.root) throw new Error("Missing public thread root");
          return parsed.root;
        }
        return selfReference(current);
      }
    }
    throw new Error("Public thread depth limit");
  }
  async resolve(
    trigger: Event,
    options: ThreadOptions = {},
  ): Promise<ThreadResult> {
    const limit = threadLimit(options.limit),
      budget = this.budget(),
      events = new Map<string, Event>([[trigger.id, trigger]]),
      batched = new Set<string>(),
      seen = new Set<string>();
    const ancestors: Event[] = [];
    let current = trigger,
      complete = true,
      reason: string | undefined;
    const declared =
      trigger.kind === 1111 ? threadStructure(trigger).root : undefined;
    const add = (items: Event[]) => {
      for (const event of items) {
        if (events.size >= this.maxEvents && !events.has(event.id)) {
          complete = false;
          reason = "size-limit";
          break;
        }
        events.set(event.id, event);
      }
    };
    const find = (ref: RootReference) =>
      [...events.values()]
        .filter((event) => matches(ref, event))
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        )[0];
    const batch = async (ref: RootReference) => {
      const key = referenceKey(ref);
      if (batched.has(key)) return;
      batched.add(key);
      const filters: Filter[] = [];
      const target = this.filter(ref);
      if (target) filters.push(target);
      if (ref.id)
        filters.push(
          { kinds: [1], "#e": [ref.id] },
          { kinds: [1111], "#E": [ref.id] },
        );
      if (ref.address)
        filters.push(
          { kinds: [1], "#a": [ref.address] },
          { kinds: [1111], "#A": [ref.address] },
        );
      if (ref.external) filters.push({ kinds: [1111], "#I": [ref.external] });
      add(
        (
          await Promise.all(filters.map((filter) => budget.query(filter)))
        ).flat(),
      );
      const root = find(ref),
        address = root && eventCoordinate(root);
      if (address && !ref.address) await batch({ ...ref, address });
    };
    try {
      const structure = threadStructure(trigger);
      if (structure.root) await batch(structure.root);
      for (let depth = 0; depth < this.maxDepth; depth++) {
        if (seen.has(current.id)) {
          complete = false;
          reason = "cycle";
          break;
        }
        seen.add(current.id);
        const parts = threadStructure(current);
        if (current.kind === 1111 && parts.root) await batch(parts.root);
        const parent = parts.parent;
        if (!parent) break;
        if (parent.external) {
          if (
            !parts.root ||
            referenceKey(parent) !== referenceKey(parts.root)
          ) {
            complete = false;
            reason = "external-parent";
          }
          break;
        }
        let next = find(parent);
        if (!next) {
          const filter = this.filter(parent);
          if (filter) add(await budget.query(filter));
          next = find(parent);
        }
        if (!next) {
          complete = false;
          reason = "missing-parent";
          break;
        }
        if (next.id === trigger.id || seen.has(next.id)) {
          complete = false;
          reason = "cycle";
          break;
        }
        if (declared) {
          const nextParts = threadStructure(next);
          if (
            next.kind === 1111 &&
            nextParts.root &&
            referenceKey(nextParts.root) !== referenceKey(declared)
          ) {
            complete = false;
            reason = "root-mismatch";
            break;
          }
          if (!nextParts.parent && !matches(declared, next)) {
            complete = false;
            reason = "root-mismatch";
            break;
          }
        }
        ancestors.push(next);
        current = next;
        if (depth === this.maxDepth - 1) {
          complete = false;
          reason = "depth-limit";
        }
      }
    } catch (error) {
      complete = false;
      reason =
        error instanceof Error &&
        ["timeout", "lookup-limit"].includes(error.message)
          ? error.message
          : "query-failed";
    }
    if (budget.bounded) {
      complete = false;
      reason ??= "query-window";
    }
    if (ancestors.length > limit) {
      complete = false;
      reason ??= "entry-limit";
    }
    // Topological oldest-to-parent order, never timestamp-sort sibling events into the context.
    return {
      entries: ancestors.slice(0, limit).reverse().map(inputOf),
      complete,
      coverage: "public-ancestors",
      ...(reason ? { reason } : {}),
    };
  }
}
export function commentReply(
  trigger: Event,
  root: RootReference,
  text: string,
  hint = "",
): EventTemplate {
  if (!text) throw new TypeError("Nonempty reply text required");
  if (!root.kind || (!root.external && !root.author))
    throw new Error("Incomplete public root");
  const tags: string[][] = [];
  if (root.address) tags.push(["A", root.address]);
  else if (root.id) {
    if (!root.author) throw new Error("Incomplete public root");
    tags.push(["E", root.id, "", root.author]);
  } else if (root.external) tags.push(["I", root.external]);
  else throw new Error("Missing public root");
  tags.push(["K", root.kind]);
  if (root.author) tags.push(["P", root.author]);
  tags.push(
    ["e", trigger.id, hint, trigger.pubkey],
    ["k", String(trigger.kind)],
    ["p", trigger.pubkey],
  );
  return {
    kind: 1111,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: text,
  };
}
