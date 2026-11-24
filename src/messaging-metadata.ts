import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import { hexKey, validTimestamp } from "./protocol.js";
import { messagingMetadata, standardRelays } from "./metadata.js";
import { InboxSubscription, type ReconnectOptions } from "./inbox.js";
import type { Store } from "./store.js";
import type { Transport } from "./relay.js";

export interface MetadataCacheOptions {
	ttlMs?: number;
	negativeTtlMs?: number;
	maxStaleMs?: number;
	maxEntries?: number;
}

interface Entry {
	events: Event[];
	at: number;
}

const newer = (a: Event, b: Event) =>
	a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

export class MessagingMetadata {
	private own = new Map<number, Event>();
	private peers = new Map<string, Entry>();
	private flights = new Map<string, Promise<Event[]>>();
	private jobs = new Set<Promise<unknown>>();
	private refreshQueue: string[] = [];
	private queued = new Set<string>();
	private refreshing = 0;
	private retryAt = new Map<string, number>();
	private watcher?: InboxSubscription;
	private starting?: Promise<void>;
	private watching = false;
	private ttl: number;
	private negative: number;
	private stale: number;
	private capacity: number;
	onOwnEvent?: (event: Event) => Promise<void>;

	constructor(
		private pubkey: string,
		private store: Store,
		private transport: Transport,
		private relays: string[],
		private error: (error: unknown) => void,
		private reconnect: false | ReconnectOptions | undefined,
		private options: false | MetadataCacheOptions = {},
	) {
		this.ttl = options === false ? 0 : (options.ttlMs ?? 600000);
		this.negative = options === false ? 0 : (options.negativeTtlMs ?? 30000);
		this.stale = options === false ? 0 : (options.maxStaleMs ?? 86400000);
		this.capacity = options === false ? 512 : (options.maxEntries ?? 512);
		for (const value of [this.ttl, this.negative, this.stale]) {
			if (!Number.isSafeInteger(value) || value < 0 || value > 31536000000) {
				throw new TypeError(
					"Metadata cache durations must be integers in 0..31536000000",
				);
			}
		}
		if (
			!Number.isSafeInteger(this.capacity) ||
			this.capacity < 1 ||
			this.capacity > 10000
		) {
			throw new TypeError("metadataCache.maxEntries must be in 1..10000");
		}
	}

	private valid(event: Event, author: string, kinds: number[]) {
		try {
			return (
				kinds.includes(event.kind) &&
				event.pubkey === author &&
				validTimestamp(event.created_at) &&
				verifyEvent(JSON.parse(JSON.stringify(event)))
			);
		} catch {
			return false;
		}
	}

	rememberOwn(event: Event) {
		if (!this.valid(event, this.pubkey, [10044, 10050])) {
			return;
		}
		const previous = this.own.get(event.kind);
		if (!previous || newer(event, previous)) {
			this.own.set(event.kind, structuredClone(event));
			if (event.kind === 10044) {
				this.store.rememberDeclaration(event);
			}
		}
	}

	private ownEvents(kinds: number[]) {
		return kinds.flatMap((kind) => {
			const event = this.own.get(kind);
			return event ? [structuredClone(event)] : [];
		});
	}

	ownDmRelays(fallback: string[]) {
		try {
			return standardRelays(this.ownEvents([10050]));
		} catch {
			return [...fallback];
		}
	}

	async start() {
		if (this.watching) {
			return;
		}
		if (this.starting) {
			return this.starting;
		}
		const task = (async () => {
			this.watcher = new InboxSubscription({
				transport: this.transport,
				store: this.store,
				relays: this.relays,
				filter: {
					authors: [this.pubkey],
					kinds: [10044, 10050, 4454],
				},
				reconnect: this.reconnect,
				recovery: false,
				receive: (event) => {
					if (!this.valid(event, this.pubkey, [10044, 10050, 4454])) {
						return;
					}
					this.rememberOwn(event);
					if (
						(event.kind === 4454 || (event.kind === 10044 && this.watching)) &&
						this.onOwnEvent
					) {
						const job = this.onOwnEvent(event);
						this.jobs.add(job);
						void job.finally(() => this.jobs.delete(job)).catch(() => {});
						return job;
					}
				},
				error: this.error,
				reconnected: async () => {},
			});
			await this.watcher.ready;
			this.watching = true;
		})()
			.catch((error) => {
				this.watcher?.close();
				this.watcher = undefined;
				throw error;
			})
			.finally(() => {
				this.starting = undefined;
			});
		this.starting = task;
		return task;
	}

	async read(peer: string, kinds: number[], force = false): Promise<Event[]> {
		if (!hexKey(peer)) {
			throw new TypeError("Invalid peer identity");
		}
		if (peer === this.pubkey && this.watching && !force) {
			return this.ownEvents(kinds);
		}
		if (peer === this.pubkey) {
			const events = await messagingMetadata(
				peer,
				kinds,
				this.transport,
				this.relays,
			);
			for (const event of events) {
				this.rememberOwn(event);
			}
			return this.ownEvents(kinds);
		}
		const entry = this.peers.get(peer),
			age = entry ? Math.max(0, Date.now() - entry.at) : Infinity;
		const usable =
			entry &&
			(() => {
				try {
					standardRelays(entry.events);
					return true;
				} catch {
					return false;
				}
			})();
		const ttl = usable ? this.ttl : this.negative;
		if (
			!force &&
			this.options !== false &&
			entry &&
			(age < ttl || (usable && age < this.stale))
		) {
			this.peers.delete(peer);
			this.peers.set(peer, entry);
			if (age >= ttl) {
				this.refresh(peer);
			}
			return structuredClone(
				entry.events.filter((event) => kinds.includes(event.kind)),
			);
		}
		try {
			return (await this.fetch(peer)).filter((event) =>
				kinds.includes(event.kind),
			);
		} catch (error) {
			if (!force && this.store.evidence(peer)) {
				this.savePeer(peer, {
					events: [],
					at: Date.now(),
				});
				return [];
			}
			throw error;
		}
	}

	private refresh(peer: string) {
		if (
			this.flights.has(peer) ||
			this.queued.has(peer) ||
			Date.now() < (this.retryAt.get(peer) ?? 0) ||
			this.refreshQueue.length >= this.capacity
		) {
			return;
		}
		this.queued.add(peer);
		this.refreshQueue.push(peer);
		this.drain();
	}

	private drain() {
		while (this.refreshing < 4 && this.refreshQueue.length) {
			const peer = this.refreshQueue.shift();
			if (peer === undefined) break;
			this.queued.delete(peer);
			if (!this.peers.has(peer)) {
				continue;
			}
			this.refreshing++;
			void this.fetch(peer)
				.catch(() => {
					if (this.peers.has(peer)) {
						this.retryAt.set(peer, Date.now() + Math.max(1000, this.negative));
					}
				})
				.finally(() => {
					this.refreshing--;
					this.drain();
				});
		}
	}

	private savePeer(peer: string, entry: Entry) {
		this.peers.delete(peer);
		this.peers.set(peer, entry);
		while (this.peers.size > this.capacity) {
			const first = this.peers.keys().next();
			if (first.done) break;
			const oldest = first.value;
			this.peers.delete(oldest);
			this.retryAt.delete(oldest);
			this.queued.delete(oldest);
		}
	}

	private fetch(peer: string) {
		const existing = this.flights.get(peer);
		if (existing) {
			return existing;
		}
		const task = messagingMetadata(
			peer,
			[10044, 10050],
			this.transport,
			this.relays,
		)
			.then((events) => {
				const previous = this.peers.get(peer),
					selected = new Map<number, Event>();
				for (const event of [...(previous?.events ?? []), ...events]) {
					const old = selected.get(event.kind);
					if (!old || newer(event, old)) {
						selected.set(event.kind, event);
					}
				}
				const result = [...selected.values()];
				this.savePeer(peer, {
					events: structuredClone(result),
					at: Date.now(),
				});
				this.retryAt.delete(peer);
				return structuredClone(result);
			})
			.finally(() => {
				this.flights.delete(peer);
			});
		this.flights.set(peer, task);
		return task;
	}

	async stop() {
		this.refreshQueue = [];
		this.queued.clear();
		this.watching = false;
		this.watcher?.close();
		this.watcher = undefined;
		await this.starting?.catch(() => {});
		this.watching = false;
		await this.idle();
	}

	async idle() {
		while (
			this.flights.size ||
			this.jobs.size ||
			this.refreshQueue.length ||
			this.refreshing
		)
			await Promise.allSettled([...this.flights.values(), ...this.jobs]);
	}
}
