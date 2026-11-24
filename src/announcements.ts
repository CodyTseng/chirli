import type { Event, EventTemplate } from "nostr-tools";
import { signChecked, type Identity } from "./protocol.js";
import { publicationGroups, relayUnion } from "./relay-roles.js";
import type { Store } from "./store.js";
import type { Transport } from "./relay.js";

interface Pending {
	event: Event;
	groups: string[][];
}

interface State {
	version: 1;
	cache: Record<string, Event>;
	pending: Pending[];
	/** Identifies the requested snapshot so a retry does not requeue acknowledged groups. */
	plan?: string;
}

export interface Announcement {
	template: EventTemplate;
	groups: string[][];
	optionalRelays?: string[];
}

const slot = (event: EventTemplate) =>
	JSON.stringify([
		event.kind,
		event.kind === 31992
			? (event.tags.find((tag) => tag[0] === "d")?.[1] ?? "")
			: "",
	]);

const same = (event: Event, template: EventTemplate) =>
	event.kind === template.kind &&
	event.content === template.content &&
	JSON.stringify(event.tags) === JSON.stringify(template.tags);

/** Durable public metadata retry. No command handlers, registry privacy inference or installation lists. */
export class Announcements {
	private state: State;
	private operation?: Promise<void>;

	constructor(
		private identity: Identity,
		private store: Store,
		private transport: Transport,
		private published?: (event: Event) => void,
	) {
		this.state = store.metadata<State>("announcements") ?? {
			version: 1,
			cache: {},
			pending: [],
		};
		if (
			this.state.version !== 1 ||
			!this.state.cache ||
			!Array.isArray(this.state.pending)
		) {
			throw new Error("Unsupported announcement state");
		}
		// This journal owns relay and media server list announcements; command operations have a separate journal.
		const supported = (event: Event) =>
			event &&
			(event.kind === 10002 || event.kind === 10050 || event.kind === 10063);
		const cache = Object.fromEntries(
			Object.entries(this.state.cache).filter(([, event]) => supported(event)),
		);
		const pending = this.state.pending.filter((item) => supported(item.event));
		if (
			Object.keys(cache).length !== Object.keys(this.state.cache).length ||
			pending.length !== this.state.pending.length
		) {
			this.save({ version: 1, cache, pending });
		}
	}

	private save(next: State) {
		this.store.saveMetadata("announcements", next);
		this.state = next;
	}

	private serialize(run: () => Promise<void>) {
		const task = (this.operation ?? Promise.resolve())
			.catch(() => {})
			.then(run);
		this.operation = task;
		void task
			.finally(() => {
				if (this.operation === task) {
					this.operation = undefined;
				}
			})
			.catch(() => {});
		return task;
	}

	publish(announcements: Announcement[]) {
		return this.serialize(async () => {
			const cache = {
				...this.state.cache,
			};
			const planned: (Pending & { optionalRelays: string[] })[] = [];
			for (const { template, groups, optionalRelays = [] } of announcements) {
				const coordinate = slot(template),
					old = cache[coordinate];
				const event =
					old && same(old, template)
						? old
						: await signChecked(this.identity, {
								...template,
								created_at: Math.max(
									template.created_at,
									(old?.created_at ?? -1) + 1,
								),
							});
				cache[coordinate] = event;
				const required = publicationGroups(groups);
				const requiredUrls = new Set(
					required.flat().map((url) => new URL(url).href),
				);
				planned.push({
					event,
					groups: required,
					optionalRelays: relayUnion(optionalRelays).filter(
						(url) => !requiredUrls.has(new URL(url).href),
					),
				});
			}
			const canonicalSet = (urls: string[]) =>
				urls.map((url) => new URL(url).href).sort();
			const plan = JSON.stringify(
				planned.map(({ event, groups, optionalRelays }) => [
					event.id,
					groups.map(canonicalSet),
					canonicalSet(optionalRelays),
				]),
			);
			// Changed settings replace old obligations; unchanged pending work keeps exact progress and IDs.
			if (!this.state.pending.length || this.state.plan !== plan) {
				this.save({
					version: 1,
					cache,
					plan,
					pending: planned.map(({ event, groups }) => ({ event, groups })),
				});
				for (const { event, optionalRelays } of planned) {
					if (optionalRelays.length) {
						// Extra discovery relays are not required acknowledgers and never enter the retry journal.
						void Promise.resolve()
							.then(() => this.transport.publish(optionalRelays, event))
							.catch(() => {});
					}
				}
			}
			await this.drain();
		});
	}

	private async drain() {
		const results = await Promise.allSettled(
			this.state.pending.flatMap(({ event, groups }) =>
				groups.map(async (group) => {
					await this.transport.publish(group, event);
					const pending = this.state.pending.find(
						(item) => item.event.id === event.id,
					);
					if (!pending) return; // Another completion has already removed this event.
					const remaining = pending.groups.filter((other) => other !== group);
					this.save({
						...this.state,
						pending: this.state.pending.flatMap((item) =>
							item.event.id !== event.id
								? [item]
								: remaining.length
									? [{ event, groups: remaining }]
									: [],
						),
					});
					if (!remaining.length) this.published?.(event);
				}),
			),
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Account metadata publication failed");
	}

	hasPending() {
		return this.state.pending.length > 0;
	}

	async idle() {
		await this.operation?.catch(() => {});
	}
}
