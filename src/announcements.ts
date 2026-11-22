import type { Event, EventTemplate } from 'nostr-tools';
import { signChecked, type Identity } from './protocol.js';
import { publicationGroups } from './relay-roles.js';
import type { Store } from './store.js';
import type { Transport } from './relay.js';

interface Pending {
  event: Event;
  groups: string[][];
}

interface State {
  version: 1;
  cache: Record<string, Event>;
  pending: Pending[];
}

export interface Announcement {
  template: EventTemplate;
  groups: string[][];
}

const slot = (event: EventTemplate) => JSON.stringify([event.kind, event.kind === 31992 ? event.tags.find(tag => tag[0] === 'd')?.[1] ?? '' : '']);

const same = (event: Event, template: EventTemplate) => event.kind === template.kind && event.content === template.content && JSON.stringify(event.tags) === JSON.stringify(template.tags);

/** Durable public metadata retry. No command handlers, registry privacy inference or installation lists. */
export class Announcements {
  private state: State;
  private operation?: Promise<void>;

  constructor(private identity: Identity, private store: Store, private transport: Transport, private published?: (event: Event) => void) {
    this.state = store.metadata<State>('announcements') ?? {
      version: 1,
      cache: {},
      pending: []
    };
    if (this.state.version !== 1 || !this.state.cache || !Array.isArray(this.state.pending)) {
      throw new Error('Unsupported announcement state');
    }
    // This journal only owns relay-list announcements; command operations have a separate journal.
    const supported = (event: Event) => event && (event.kind === 10002 || event.kind === 10050);
    const cache = Object.fromEntries(Object.entries(this.state.cache).filter(([,event]) => supported(event)));
    const pending = this.state.pending.filter(item => supported(item.event));
    if (Object.keys(cache).length !== Object.keys(this.state.cache).length || pending.length !== this.state.pending.length) {
      this.save({version:1,cache,pending});
    }
  }

  private save(next: State) {
    this.store.saveMetadata('announcements', next);
    this.state = next;
  }

  private serialize(run: () => Promise<void>) {
    const task = (this.operation ?? Promise.resolve()).catch(() => {
    }).then(run);
    this.operation = task;
    void task.finally(() => {
      if (this.operation === task) {
        this.operation = undefined;
      }
    }).catch(() => {
    });
    return task;
  }

  publish(announcements: Announcement[]) {
    return this.serialize(async () => {
      const cache = {
        ...this.state.cache
      }, pending: Pending[] = [];
      for (const { template, groups } of announcements) {
        const coordinate = slot(template), old = cache[coordinate];
        const event = old && same(old, template) ? old : await signChecked(this.identity, {
          ...template, created_at: Math.max(template.created_at, (old?.created_at ?? -1) + 1)
        });
        cache[coordinate] = event;
        pending.push({
          event, groups: publicationGroups(groups)
        });
      }
      // Retry the current relay-list snapshot; command publication has its own journal.
      this.save({
        version: 1,
        cache,
        pending
      });
      await this.drain();
    });
  }

  private async drain() {
    while (this.state.pending.length) {
      const item = this.state.pending[0];
      for (const group of item.groups) {
        await this.transport.publish(group, item.event);
      }
      this.published?.(item.event);
      this.save({
        ...this.state, pending: this.state.pending.slice(1)
      });
    }
  }

  hasPending() {
    return this.state.pending.length > 0;
  }

  async idle() {
    await this.operation?.catch(() => {
    });
  }
}
