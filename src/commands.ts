import { verifyEvent, type Event } from "nostr-tools";
import { signChecked, validTimestamp, type Identity } from "./protocol.js";
import {
  commandAddress,
  decodeCommandDefinition,
  encodeCommandDefinition,
  encodeCommandRevocation,
  validateCommandDefinition,
  type CommandDefinition,
} from "./nipcd.js";
import type { Store } from "./store.js";
import type { Transport } from "./relay.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

interface State {
  version: 1;
  known: Event[];
  pending: Event[];
}

export interface CommandSyncResult {
  added: string[];
  updated: string[];
  removed: string[];
}

const identifier = (event: Event) =>
  event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
const newer = (a: Event, b: Event) =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
const equal = (a: CommandDefinition, b: CommandDefinition) =>
  JSON.stringify(validateCommandDefinition(a)) ===
  JSON.stringify(validateCommandDefinition(b));

/** Reconciles one account's authoritative command registry on its configured write relays. */
export class CommandCatalog {
  private state: State;
  private operation?: Promise<CommandSyncResult>;

  constructor(
    private identity: Identity,
    private store: Store,
    private transport: Transport,
    private relays: string[],
  ) {
    this.state = store.metadata<State>("command-catalog") ?? {
      version: 1,
      known: [],
      pending: [],
    };
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.known) ||
      !Array.isArray(this.state.pending)
    ) {
      throw new Error("Unsupported command catalog state");
    }
    // Old journals may contain unrelated event kinds. Retain only supported command operations.
    const supported = (events: Event[]) =>
      events.flatMap((event) => {
        const valid =
          event && (event.kind === 31992 || event.kind === 5)
            ? this.verified(event, event.kind)
            : undefined;
        return valid ? [valid] : [];
      });
    const known = supported(this.state.known),
      pending = supported(this.state.pending);
    if (
      known.length !== this.state.known.length ||
      pending.length !== this.state.pending.length
    ) {
      this.save({ version: 1, known, pending });
    }
  }

  private verified(input: Event, kind: number): Event | undefined {
    try {
      const event: Event = JSON.parse(JSON.stringify(input));
      if (
        event.kind === kind &&
        event.pubkey === this.identity.pubkey &&
        validTimestamp(event.created_at) &&
        verifyEvent(event)
      )
        return event;
    } catch {
      /* Untrusted frames never become registry or deletion evidence. */
    }
  }

  private save(state: State) {
    this.store.saveMetadata("command-catalog", state);
    this.state = state;
  }

  private check(active: () => boolean) {
    if (!active()) throw new Error("Command synchronization canceled");
  }

  private async readKind(
    relay: string,
    kind: number,
    active: () => boolean,
  ): Promise<Event[]> {
    const events = new Map<string, Event>();
    let until: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      this.check(active);
      const frames = await this.transport.query([relay], {
        kinds: [kind],
        authors: [this.identity.pubkey],
        limit: PAGE_SIZE,
        ...(until === undefined ? {} : { until }),
      });
      this.check(active);
      const valid = frames.flatMap((frame) => {
        const event = this.verified(frame, kind);
        return event && (until === undefined || event.created_at <= until)
          ? [event]
          : [];
      });
      for (const event of valid) events.set(event.id, event);
      if (frames.length < PAGE_SIZE) return [...events.values()];
      const oldest = Math.min(...valid.map((event) => event.created_at));
      // Never infer deletions from a truncated or saturated timestamp bucket.
      if (!Number.isFinite(oldest) || oldest === until)
        throw new Error(
          "Command query incomplete: timestamp boundary saturated",
        );
      until = oldest;
    }
    throw new Error("Command query incomplete: page limit reached");
  }

  private compact(events: Event[]): Event[] {
    const slots = new Map<string, Event>();
    for (const event of events) {
      const keys =
        event.kind === 31992
          ? [`definition:${identifier(event)}`]
          : event.kind === 5
            ? event.tags
                .filter((tag) => tag[0] === "a" || tag[0] === "e")
                .map((tag) => `${tag[0]}:${tag[1]}`)
            : [];
      for (const key of keys) {
        const old = slots.get(key);
        if (!old || newer(event, old)) slots.set(key, event);
      }
    }
    return [
      ...new Map(
        [...slots.values()].map((event) => [event.id, event]),
      ).values(),
    ];
  }

  private deleted(event: Event, events: Event[]): boolean {
    const address = commandAddress(this.identity.pubkey, identifier(event));
    return events.some(
      (deletion) =>
        deletion.kind === 5 &&
        deletion.tags.some(
          (tag) =>
            (tag[0] === "a" &&
              tag[1] === address &&
              deletion.created_at >= event.created_at) ||
            (tag[0] === "e" && tag[1] === event.id),
        ),
    );
  }

  sync(
    definitions: CommandDefinition[],
    removals: string[] = [],
    active: () => boolean = () => true,
  ): Promise<CommandSyncResult> {
    const desired = definitions.map(validateCommandDefinition);
    const task = (this.operation ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.reconcile(desired, removals, active));
    this.operation = task;
    void task
      .finally(() => {
        if (this.operation === task) this.operation = undefined;
      })
      .catch(() => {});
    return task;
  }

  private async reconcile(
    definitions: CommandDefinition[],
    removals: string[],
    active: () => boolean,
  ): Promise<CommandSyncResult> {
    // Query every write relay independently. Partial transport query success is unsafe here.
    const reads = await Promise.all(
      this.relays.map((relay) => this.readKind(relay, 31992, active)),
    );
    this.check(active);
    const events = [
      ...new Map(
        [...reads.flat(), ...this.state.known, ...this.state.pending].map(
          (event) => [event.id, event],
        ),
      ).values(),
    ];
    const desired = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    const latest = new Map<string, Event>();
    // Fresh relay presence and unacknowledged definitions are actionable; confirmed cache alone is not.
    for (const event of [...reads.flat(), ...this.state.pending]) {
      if (event.kind !== 31992) continue;
      const id = identifier(event),
        old = latest.get(id);
      if (!old || newer(event, old)) latest.set(id, event);
    }
    const pending: Event[] = [],
      known = new Map(events.map((event) => [event.id, event]));
    const result = {
      added: [] as string[],
      updated: [] as string[],
      removed: [] as string[],
    };
    const now = Math.floor(Date.now() / 1000);
    const onEveryRelay = (event: Event) =>
      reads.every((read) => read.some((copy) => copy.id === event.id));
    const enqueue = (event: Event) => {
      known.set(event.id, event);
      if (!onEveryRelay(event)) pending.push(event);
    };
    const timeFor = (id: string) => {
      const address = commandAddress(this.identity.pubkey, id);
      return Math.max(
        now,
        ...events
          .filter(
            (event) =>
              (event.kind === 31992 && identifier(event) === id) ||
              (event.kind === 5 &&
                event.tags.some((tag) => tag[0] === "a" && tag[1] === address)),
          )
          .map((event) => event.created_at + 1),
      );
    };

    for (const [id, definition] of desired) {
      this.check(active);
      const previous = latest.get(id),
        parsed =
          previous && !this.deleted(previous, events)
            ? decodeCommandDefinition(previous)
            : undefined;
      if (previous && parsed && equal(parsed.definition, definition)) {
        enqueue(previous);
      } else {
        const event = await signChecked(
          this.identity,
          encodeCommandDefinition(definition, timeFor(id)),
        );
        enqueue(event);
        (previous ? result.updated : result.added).push(id);
      }
    }

    const prefix = `31992:${this.identity.pubkey}:`;
    const withdrawn = this.state.pending.flatMap((event) =>
      event.kind === 5
        ? event.tags.flatMap((tag) =>
            tag[0] === "a" && tag[1]?.startsWith(prefix)
              ? [tag[1].slice(prefix.length)]
              : [],
          )
        : [],
    );
    for (const id of new Set([...latest.keys(), ...withdrawn, ...removals])) {
      if (desired.has(id)) continue;
      const previous = latest.get(id);
      const address = commandAddress(this.identity.pubkey, id);
      const deletion = events
        .filter(
          (event) =>
            event.kind === 5 &&
            event.tags.some((tag) => tag[0] === "a" && tag[1] === address),
        )
        .sort(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        )[0];
      if (
        deletion &&
        (!previous || deletion.created_at >= previous.created_at)
      ) {
        // A tombstone staged before a crash is not proof every relay received it.
        if (!onEveryRelay(deletion)) result.removed.push(id);
        enqueue(deletion);
      } else {
        enqueue(
          await signChecked(
            this.identity,
            encodeCommandRevocation(this.identity.pubkey, id, timeFor(id)),
          ),
        );
        result.removed.push(id);
      }
    }

    this.check(active);
    this.save({
      version: 1,
      known: this.compact([...known.values()]),
      pending,
    });
    while (this.state.pending.length) {
      this.check(active);
      const event = this.state.pending[0];
      const outcomes = await Promise.allSettled(
        this.relays.map((relay) => this.transport.publish([relay], event)),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "Command publication failed on write relays",
        );
      this.save({ ...this.state, pending: this.state.pending.slice(1) });
    }
    return result;
  }

  definition(id: string): Event | undefined {
    return this.state.known
      .filter((event) => event.kind === 31992 && identifier(event) === id)
      .sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0];
  }

  revocation(id: string): Event | undefined {
    const address = commandAddress(this.identity.pubkey, id);
    return this.state.known
      .filter(
        (event) =>
          event.kind === 5 &&
          event.tags.some((tag) => tag[0] === "a" && tag[1] === address),
      )
      .sort(
        (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
      )[0];
  }

  hasPending(): boolean {
    return this.state.pending.length > 0;
  }

  async idle() {
    await this.operation?.catch(() => {});
  }
}
