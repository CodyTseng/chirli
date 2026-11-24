import type {
  ReplyFileOptions,
  SendFileOptions,
  UploadFileOptions,
} from "./blossom.js";
import type { SessionStore } from "./session.js";
import {
  Client,
  rejectRemovedIntakeOptions,
  type ClientOptions,
  type ErrorHandler,
  type IntakeMetadata,
  type SendOptions,
  type MessageObserver,
} from "./client.js";
import { BotHandlers, type Middleware } from "./bot-handlers.js";
import type { AnnounceOptions } from "./keys.js";
import type {
  BotCommandOptions,
  CommandHandler,
  Context,
  MessageHandler,
} from "./bot-handlers.js";
import type { BotCommandDefinition, DiscoverCommandsOptions } from "./nipcd.js";
import type { Event } from "nostr-tools";
import type { Rumor } from "./protocol.js";
import type { ThreadOptions } from "./public-thread.js";
import type { Message, MessageListOptions } from "./store.js";

export type {
  CommandContext,
  BotCommandOptions,
  CommandHandler,
  Context,
  MessageHandler,
  Middleware,
  Next,
} from "./bot-handlers.js";
export type { Session, SessionStore } from "./session.js";

export type BotOptions<S = Record<string, unknown>> = ClientOptions & {
  sessionStore?: SessionStore<S>;
};

export class Bot<S = Record<string, unknown>> {
  #client?: Client;
  #opening?: Promise<Client>;
  #starting?: Promise<void>;
  #stopping?: Promise<void>;
  #closing?: Promise<void>;
  #generation = 0;
  #handlers: BotHandlers<S>;
  #errorHandlers = new Set<ErrorHandler>();
  #observers = new Set<MessageObserver>();

  #options: ClientOptions;

  constructor(input: BotOptions<S>) {
    rejectRemovedIntakeOptions(input);
    const { sessionStore, ...options } = input;
    this.#options = {
      ...options,
      relays: options.relays?.slice(),
      dmRelays: options.dmRelays?.slice(),
      readRelays: options.readRelays?.slice(),
      writeRelays: options.writeRelays?.slice(),
      discoveryRelays: options.discoveryRelays?.slice(),
      blossomServers: options.blossomServers?.slice(),
      blossomDownloadOrigins: options.blossomDownloadOrigins?.slice(),
      publicInbox: options.publicInbox
        ? {
            ...options.publicInbox,
            relays: options.publicInbox.relays.slice(),
            thread: options.publicInbox.thread
              ? { ...options.publicInbox.thread }
              : undefined,
          }
        : undefined,
      storageKey: options.storageKey?.slice(),
    };
    this.#handlers = new BotHandlers(undefined, { sessionStore });
  }

  #ready(): Client {
    if (!this.#client)
      throw new Error("Call and await bot.start() before accessing bot state");
    return this.#client;
  }

  #open(): Promise<Client> {
    if (this.#closing)
      return Promise.reject(new Error("Bot is closed or closing"));
    if (this.#client) return Promise.resolve(this.#client);
    this.#opening ??= Client.create(this.#options)
      .then((client) => {
        try {
          this.#handlers.attach(client);
        } catch (error) {
          return client.close().then(() => {
            throw error;
          });
        }
        client.onError((error, message) => {
          for (const handler of this.#errorHandlers) {
            void Promise.resolve()
              .then(() => handler(error, message))
              .catch(() => {});
          }
        });
        client.on("message", (message) => {
          for (const observer of this.#observers) {
            void Promise.resolve()
              .then(() =>
                observer(client.withAttachment(structuredClone(message))),
              )
              .catch((error) => client.report(error, structuredClone(message)));
          }
        });
        this.#client = client;
        return client;
      })
      .finally(() => {
        this.#opening = undefined;
      });
    return this.#opening;
  }

  get pubkey() {
    return this.#ready().pubkey;
  }
  get mode() {
    return this.#options.mode ?? "nip17";
  }

  use(fn: Middleware<S>) {
    this.#handlers.use(fn);
    return this;
  }
  catch(fn: (error: unknown, ctx: Context<S>) => unknown) {
    this.#handlers.catch(fn);
    return this;
  }
  command<const D extends BotCommandDefinition>(
    command: D,
    fn: CommandHandler<NoInfer<D>, S>,
    options?: BotCommandOptions<S, NoInfer<D>>,
  ) {
    this.#handlers.command(command, fn, options);
    return this;
  }

  getCommandDefinitions() {
    return this.#handlers.getCommandDefinitions();
  }

  handle(handler: MessageHandler<S>): () => void {
    return this.#handlers.handle(handler);
  }

  observe(observer: MessageObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  onError(handler: ErrorHandler): () => void {
    this.#errorHandlers.add(handler);
    return () => {
      this.#errorHandlers.delete(handler);
    };
  }

  start(): Promise<void> {
    if (this.#closing)
      return Promise.reject(new Error("Bot is closed or closing"));
    if (this.#stopping) return this.#stopping.then(() => this.start());
    const generation = this.#generation;
    this.#starting ??= this.#open()
      .then((client) => {
        if (this.#generation === generation) return client.start(true);
      })
      .finally(() => {
        this.#starting = undefined;
      });
    return this.#starting;
  }

  async stop(): Promise<void> {
    this.#client?.assertOutsideHandler();
    if (this.#closing) return this.#closing;
    this.#stopping ??= this.#shutdown(false).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async close(): Promise<void> {
    this.#client?.assertOutsideHandler();
    if (this.#closing) return this.#closing;
    const task = this.#shutdown(true);
    this.#closing = task;
    void task.catch(() => {
      if (this.#closing === task) this.#closing = undefined;
    });
    return task;
  }

  async #shutdown(close: boolean) {
    this.#generation++;
    const client =
      this.#client ?? (await this.#opening?.catch(() => undefined));
    if (client) {
      if (close) await client.close();
      else await client.stop();
    }
    if (close) this.#handlers.dispose();
  }

  requestStop() {
    this.#generation++;
    this.#ready().requestStop();
  }
  async announce(options?: AnnounceOptions) {
    await (await this.#open()).announce(options);
  }
  async reply(event: Event | Rumor, text: string, options?: SendOptions) {
    return this.#ready().reply(event, text, options);
  }
  async replyFile(
    event: Event | Rumor,
    data: Uint8Array,
    options?: ReplyFileOptions,
  ) {
    return this.#ready().replyFile(event, data, options);
  }
  async thread(event: Event | Rumor, options?: ThreadOptions) {
    return this.#ready().thread(event, options);
  }
  send(peer: string, text: string, options?: SendOptions) {
    return this.#ready().send(peer, text, options);
  }
  uploadFile(data: Uint8Array, options?: UploadFileOptions) {
    return this.#ready().uploadFile(data, options);
  }
  sendFile(peer: string, data: Uint8Array, options?: SendFileOptions) {
    return this.#ready().sendFile(peer, data, options);
  }
  dmHistory(peerPubkey: string, options?: { limit?: number; cursor?: string }) {
    return this.#ready().history(peerPubkey, options);
  }
  async react(event: Event | Rumor, reaction?: string) {
    return this.#ready().react(event, reaction);
  }
  getMessage(id: string): Message | undefined {
    return this.#ready().getMessage(id);
  }
  idle() {
    return this.#ready().idle();
  }
  receive(event: Event, source: "live" | "history", metadata?: IntakeMetadata) {
    return this.#ready().receive(event, source, metadata);
  }
  getMessageState(id: string) {
    return this.#ready().getMessageState(id);
  }
  listMessages(options?: MessageListOptions) {
    return this.#ready().listMessages(options);
  }
  async getSession(peer: string): Promise<Partial<S> | undefined> {
    return structuredClone(
      await this.#handlers.sessionStore(this.#ready()).get(peer),
    );
  }

  async setSession(peer: string, value: Partial<S>): Promise<void> {
    await this.#handlers
      .sessionStore(this.#ready())
      .set(peer, structuredClone(value));
  }
  syncHistory() {
    return this.#ready().syncHistory();
  }
  syncCommands() {
    return this.#ready().syncCommands();
  }
  discoverCommands(options: DiscoverCommandsOptions) {
    return this.#ready().discoverCommands(options);
  }
  flushAnnouncements() {
    return this.#ready().flushAnnouncements();
  }
  flushOutbox() {
    return this.#ready().flushOutbox();
  }
  encryptionKeys() {
    return this.#ready().encryptionKeys();
  }
  rotateEncryptionKey() {
    return this.#ready().rotateEncryptionKey();
  }
  refreshPeer(peer: string) {
    return this.#ready().refreshPeer(peer);
  }
}
