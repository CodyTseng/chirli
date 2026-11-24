import type { Event } from "nostr-tools";
import {
  generateSecretKey,
  getPublicKey,
  hexKey,
  identityMessagingKey,
  signChecked,
  type Identity,
} from "./protocol.js";
import type { MessagingMetadata } from "./messaging-metadata.js";
import { publicationGroups } from "./relay-roles.js";
import { messagingMetadata } from "./metadata.js";
import { Nip4eCompatibilityError } from "./errors.js";
import type { Store } from "./store.js";
import type { Transport } from "./relay.js";
import type { ProtocolMode } from "./modes.js";

export interface KeyRotationOptions {
  /** Automatic rotation while started; minimum 1000 ms. Configuration authorizes declarations. */
  intervalMs: number;
  /** Number of retired split keys retained after successful rotation; default 5, minimum 1. */
  retainLegacyKeys?: number;
  /** Optional retirement age limit. Omit to apply only the count bound. */
  legacyMaxAgeMs?: number;
}

export interface AnnounceOptions {
  replaceEncryptionKey?: string;
}

interface Key {
  secret: string;
  since: number;
}

interface Retired extends Key {
  retiredAt: number;
}

interface Pending {
  event: Event;
  secret?: string;
  previous?: string;
}

interface State {
  version: 1;
  bootstrapPublicKey?: string;
  active?: Key;
  legacy: Retired[];
  pending?: Pending;
}

export interface EncryptionKeyStatus {
  currentPublicKey: string;
  activatedAt?: number;
  decryptionPublicKeys: string[];
  legacy: {
    publicKey: string;
    retiredAt: number;
  }[];
  pending?: {
    publicKey: string;
    eventId: string;
  };
}

const secret = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

const pub = (value: string) => getPublicKey(secret(value));

const encoded = (value: Uint8Array) => Buffer.from(value).toString("hex");

/** One account-local codec-protected keyring, independent of message-mode database scope. */
export class EncryptionKeys {
  private state: State;
  private operation?: Promise<void>;
  readonly rotation?: Required<
    Pick<KeyRotationOptions, "intervalMs" | "retainLegacyKeys">
  > &
    Pick<KeyRotationOptions, "legacyMaxAgeMs">;

  constructor(
    private identity: Identity,
    private mode: ProtocolMode,
    private store: Store,
    private transport: Transport,
    private relays: string[],
    options?: false | KeyRotationOptions,
    private publishRelays: string[][] = [relays],
    private metadata?: MessagingMetadata,
  ) {
    identityMessagingKey(identity);
    if (options) {
      if (mode !== "nip4e") {
        throw new TypeError("keyRotation requires explicit mode: nip4e");
      }
      if (
        !Number.isSafeInteger(options.intervalMs) ||
        options.intervalMs < 1000 ||
        options.intervalMs > Number.MAX_SAFE_INTEGER / 2
      ) {
        throw new TypeError("intervalMs must be a safe integer >= 1000");
      }
      const retain = options.retainLegacyKeys ?? 5;
      if (!Number.isSafeInteger(retain) || retain < 1 || retain > 100) {
        throw new TypeError("retainLegacyKeys must be in 1..100");
      }
      if (
        options.legacyMaxAgeMs !== undefined &&
        (!Number.isSafeInteger(options.legacyMaxAgeMs) ||
          options.legacyMaxAgeMs < 1000)
      ) {
        throw new TypeError("legacyMaxAgeMs must be >= 1000");
      }
      this.rotation = {
        ...options,
        retainLegacyKeys: retain,
      };
    }
    this.state = store.keyring<State>(identity.pubkey) ?? {
      version: 1,
      legacy: [],
    };
    if (this.state.version !== 1 || !Array.isArray(this.state.legacy)) {
      throw new Error("Unsupported encryption keyring");
    }
    // A stale application-supplied initial key may be a retained key after restart.
    const supplied =
      identity.encryptionKey &&
      getPublicKey(identity.encryptionKey) !== identity.pubkey
        ? encoded(identity.encryptionKey)
        : undefined;
    if (mode === "nip4e") {
      if (!this.state.active) {
        this.state.active = {
          secret: supplied ?? encoded(generateSecretKey()),
          since: Date.now(),
        };
        this.state.bootstrapPublicKey = pub(this.state.active.secret);
      } else if (
        supplied &&
        pub(supplied) !== this.state.bootstrapPublicKey &&
        supplied !== this.state.active.secret &&
        !this.state.legacy.some((k) => k.secret === supplied)
      ) {
        throw new Error(
          "Supplied messaging key conflicts with persisted keyring; use the saved account keyring",
        );
      }
    }
    for (const key of identity.oldEncryptionKeys ?? []) {
      const value = encoded(key);
      if (
        getPublicKey(key) !== identity.pubkey &&
        value !== this.state.active?.secret &&
        !this.state.legacy.some((k) => k.secret === value)
      ) {
        this.state.legacy.push({
          secret: value,
          since: Date.now(),
          retiredAt: Date.now(),
        });
      }
    }
    this.save();
    this.apply();
  }

  private save() {
    this.store.saveKeyring(this.identity.pubkey, this.state);
  }

  private apply() {
    const keys = [
      ...(this.state.active ? [this.state.active] : []),
      ...this.state.legacy,
      ...(this.state.pending?.secret
        ? [
            {
              secret: this.state.pending.secret,
              since: 0,
            },
          ]
        : []),
    ];
    this.identity.oldEncryptionKeys = [...new Set(keys.map((k) => k.secret))]
      .filter((k) => this.mode !== "nip4e" || k !== this.state.active?.secret)
      .map(secret);
    if (this.mode === "nip4e") {
      this.identity.encryptionKey = secret(this.activeKey().secret);
    }
  }

  private activeKey() {
    const active = this.state.active;
    if (!active) throw new Error("Missing active encryption key");
    return active;
  }

  current() {
    return this.mode === "nip4e"
      ? pub(this.activeKey().secret)
      : this.identity.pubkey;
  }

  status(): EncryptionKeyStatus {
    return {
      currentPublicKey: this.current(),
      decryptionPublicKeys: [
        ...new Set([
          this.identity.pubkey,
          ...(this.state.active ? [pub(this.state.active.secret)] : []),
          ...this.state.legacy.map((k) => pub(k.secret)),
          ...(this.state.pending?.secret
            ? [pub(this.state.pending.secret)]
            : []),
        ]),
      ],
      activatedAt: this.mode === "nip4e" ? this.state.active?.since : undefined,
      legacy: this.state.legacy.map((k) => ({
        publicKey: pub(k.secret),
        retiredAt: k.retiredAt,
      })),
      ...(this.state.pending
        ? {
            pending: {
              publicKey: this.state.pending.event.tags[0][1],
              eventId: this.state.pending.event.id,
            },
          }
        : {}),
    };
  }

  private knows(key: string) {
    return (
      key === this.identity.pubkey ||
      [this.state.active, ...this.state.legacy].some(
        (k) => k && pub(k.secret) === key,
      )
    );
  }
  onImported?: () => void;
  private synchronize?: (key: string) => Promise<Uint8Array>;

  setSynchronizer(sync: (key: string) => Promise<Uint8Array>) {
    this.synchronize = sync;
  }

  exportEncryptionKey(key = this.current()): Uint8Array | undefined {
    if (key === this.identity.pubkey) {
      return;
    }
    const found = [
      this.state.active,
      ...this.state.legacy,
      ...(this.state.pending?.secret
        ? [
            {
              secret: this.state.pending.secret,
              since: 0,
            },
          ]
        : []),
    ].find((value) => value && pub(value.secret) === key);
    return found ? secret(found.secret) : undefined;
  }

  private async accept(event: Event | undefined, allowed: string[]) {
    const key = event?.tags.find((tag) => tag[0] === "n")?.[1];
    if (
      this.mode === "nip4e" &&
      this.synchronize &&
      hexKey(key) &&
      key !== this.identity.pubkey &&
      !allowed.includes(key) &&
      !this.state.pending
    ) {
      const value =
        this.exportEncryptionKey(key) ?? (await this.synchronize(key));
      try {
        if (
          getPublicKey(value) !== key ||
          this.store
            .declaration(this.identity.pubkey)
            ?.tags.find((tag) => tag[0] === "n")?.[1] !== key
        ) {
          throw new Error(
            "Key synchronization no longer matches the current declaration",
          );
        }
        const now = Date.now(),
          next = structuredClone(this.state);
        if (next.active) {
          next.legacy.unshift({
            ...next.active,
            retiredAt: now,
          });
        }
        next.active = {
          secret: encoded(value),
          since: now,
        };
        const seen = new Set([key]);
        next.legacy = next.legacy
          .filter((item) => {
            const publicKey = pub(item.secret);
            if (seen.has(publicKey)) {
              return false;
            }
            seen.add(publicKey);
            return true;
          })
          .slice(0, this.rotation?.retainLegacyKeys ?? 5);
        this.store.saveKeyring(this.identity.pubkey, next);
        this.state = next;
        this.apply();
        this.onImported?.();
      } finally {
        value.fill(0);
      }
    }
    this.check(event, [...allowed, this.current()]);
  }

  private async declaration() {
    for (const event of await (this.metadata
      ? this.metadata.read(this.identity.pubkey, [10044])
      : messagingMetadata(
          this.identity.pubkey,
          [10044],
          this.transport,
          this.relays,
        ))) {
      this.store.rememberDeclaration(event);
    }
    return this.store.declaration(this.identity.pubkey);
  }

  private check(event: Event | undefined, allowed: string[]) {
    if (!event) {
      return;
    }
    const key = event.tags.find((t) => t[0] === "n")?.[1];
    if (!hexKey(key)) {
      throw new Nip4eCompatibilityError("NIP4E_DECLARATION_INVALID");
    }
    if (!allowed.includes(key)) {
      throw new Nip4eCompatibilityError("NIP4E_KEY_CONFLICT");
    }
  }

  private serialize(run: () => Promise<void>): Promise<void> {
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

  private async resume() {
    const pending = this.state.pending;
    if (!pending) {
      return;
    }
    // A mode change must finish the previously authorized operation in its original mode.
    const target = pending.event.tags[0][1];
    if (
      (pending.secret && this.mode !== "nip4e") ||
      (!pending.secret && target !== this.current())
    ) {
      throw new Error(
        "Pending key declaration belongs to the previous mode; resume it before switching modes",
      );
    }
    this.check(await this.declaration(), [
      target,
      ...(pending.previous ? [pending.previous] : []),
    ]);
    this.save();
    this.apply(); // Reassert durable custody after any prior local persistence failure.
    for (const group of publicationGroups(this.publishRelays)) {
      await this.transport.publish(group, pending.event);
    }
    // Keep the exact signed declaration until ACK; keys were already durable before publish.
    this.store.rememberDeclaration(pending.event);
    this.metadata?.rememberOwn(pending.event);
    const next: State = structuredClone(this.state);
    if (pending.secret) {
      const now = Date.now();
      if (next.active) {
        next.legacy.unshift({
          ...next.active,
          retiredAt: now,
        });
      }
      next.active = {
        secret: pending.secret,
        since: now,
      };
      const retain = this.rotation?.retainLegacyKeys ?? 5,
        age = this.rotation?.legacyMaxAgeMs;
      next.legacy = next.legacy
        .filter((k) => age === undefined || now - k.retiredAt <= age)
        .slice(0, retain);
    }
    delete next.pending;
    this.store.saveKeyring(this.identity.pubkey, next);
    this.state = next;
    this.apply();
  }

  async prepare() {
    await this.serialize(async () => {
      await this.resume();
      await this.accept(await this.declaration(), [this.current()]);
    });
  }

  async announce(options: AnnounceOptions = {}) {
    await this.serialize(async () => {
      await this.resume();
      const current = await this.declaration(),
        old = current?.tags.find((t) => t[0] === "n")?.[1];
      if (
        options.replaceEncryptionKey !== undefined &&
        (!hexKey(options.replaceEncryptionKey) ||
          old !== options.replaceEncryptionKey ||
          !this.knows(options.replaceEncryptionKey))
      ) {
        throw new Error(
          "replaceEncryptionKey must match the latest declaration and a locally available decryption key",
        );
      }
      await this.accept(current, [
        this.current(),
        ...(options.replaceEncryptionKey ? [options.replaceEncryptionKey] : []),
      ]);
      if (current && old === this.current()) {
        // Reuse the signed declaration but rebroadcast to current write/DM sets.
        const next: State = {
          ...this.state,
          pending: {
            event: current,
            previous: old,
          },
        };
        this.store.saveKeyring(this.identity.pubkey, next);
        this.state = next;
        await this.resume();
        return;
      }
      await this.stage(this.current(), current, undefined);
    });
  }

  private async stage(
    key: string,
    previous: Event | undefined,
    value: string | undefined,
  ) {
    // Strictly newer than all known declaration/old-seal seconds, including rapid rotations.
    const created_at = Math.max(
      Math.floor(Date.now() / 1000) + 1,
      (previous?.created_at ?? 0) + 1,
    );
    const event = await signChecked(this.identity, {
      kind: 10044,
      created_at,
      tags: [["n", key]],
      content: "",
    });
    const previousKey = previous?.tags.find((tag) => tag[0] === "n")?.[1];
    const next: State = {
      ...this.state,
      pending: {
        event,
        ...(value
          ? {
              secret: value,
            }
          : {}),
        ...(previousKey === undefined ? {} : { previous: previousKey }),
      },
    };
    this.store.saveKeyring(this.identity.pubkey, next);
    this.state = next;
    this.apply();
    await this.resume();
  }
  private rotating?: Promise<void>;

  rotate() {
    if (this.mode !== "nip4e") {
      return Promise.reject(
        new Error("Encryption-key rotation requires mode: nip4e"),
      );
    }
    if (this.rotating) {
      return this.rotating;
    }
    const task = this.serialize(async () => {
      if (this.state.pending) {
        await this.resume();
        return;
      }
      const current = await this.declaration();
      await this.accept(current, [this.current()]);
      const value = encoded(generateSecretKey());
      await this.stage(pub(value), current, value);
    });
    this.rotating = task;
    void task
      .finally(() => {
        if (this.rotating === task) {
          this.rotating = undefined;
        }
      })
      .catch(() => {});
    return task;
  }

  async rotateIfDue() {
    if (
      this.rotation &&
      Date.now() - this.activeKey().since >= this.rotation.intervalMs
    ) {
      await this.rotate();
    }
  }

  nextDelay() {
    return this.rotation
      ? Math.min(
          2147483647,
          Math.max(
            1000,
            this.rotation.intervalMs - (Date.now() - this.activeKey().since),
          ),
        )
      : undefined;
  }

  async idle() {
    await this.operation?.catch(() => {});
  }
}
