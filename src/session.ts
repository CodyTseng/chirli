export interface Session<S> {
  getItem<K extends keyof S & string>(key: K): Promise<S[K] | undefined>;
  setItem<K extends keyof S & string>(key: K, value: Exclude<S[NoInfer<K>], undefined>): void;
  removeItem(key: keyof S & string): void;
  clear(): void;
}

export interface SessionStore<S> {
  get(conversation: string): Partial<S> | undefined | Promise<Partial<S> | undefined>;
  /** Save the full snapshot, including any removals. */
  set(conversation: string, value: Partial<S>): void | Promise<void>;
}

/** A message sees its own writes. Commit once after successful processing. */
export function messageSession<S>(store: SessionStore<S>, conversation: string) {
  let snapshot: Promise<Partial<S>> | undefined;
  const load = (): Promise<Partial<S>> => snapshot ??= Promise.resolve().then(async () => {
    const data: Partial<S> = await store.get(conversation) ?? {};
    return structuredClone(data);
  });
  let writes: Partial<S> = Object.create(null);
  const removals = new Set<keyof S & string>();
  let cleared = false;

  const session: Session<S> = {
    async getItem(key) {
      if (removals.has(key)) return undefined;
      if (Object.hasOwn(writes, key)) return structuredClone(writes[key]);
      if (cleared) return undefined;
      const data = await load();
      return Object.hasOwn(data, key) ? structuredClone(data[key]) : undefined;
    },

    setItem(key, value) {
      if (value === undefined) throw new TypeError('Use removeItem to delete a session value');
      writes[key] = structuredClone(value);
      removals.delete(key);
    },

    removeItem(key) {
      delete writes[key];
      removals.add(key);
    },

    clear() {
      writes = Object.create(null);
      removals.clear();
      cleared = true;
    },
  };

  return {
    session,
    async commit() {
      if (!cleared && !Object.keys(writes).length && !removals.size) return;
      const updated = cleared ? { ...writes } : { ...await load(), ...writes };
      for (const key of removals) delete updated[key];
      await store.set(conversation, updated);
    },
  };
}
