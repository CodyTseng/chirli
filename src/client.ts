import { encryptAttachment, normalizeBlossomDownloadOrigins, normalizeBlossomServers, snapshotFile, uploadFile, type ReplyFileOptions, type SendFileOptions, type UploadFileOptions, type UploadFileResult } from './blossom.js';
import { PublicInbox, type PublicInboxOptions, type PublicInput } from './public-inbox.js';
import { inputOf, threadLimit, type ThreadOptions, type ThreadResult } from './public-thread.js';
import type { InboundPolicy } from './inbound-policy.js';
import {getEventHash, type Event} from 'nostr-tools';
import { identityFromSigner } from './signers.js';
import type { Signer } from './signer.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Store, type Message } from './store.js';
import {localReadBoundary, WebSocketTransport, type Transport, type WebSocketTransportOptions } from './relay.js';
import { fileRumor, hexKey, reactionRumor, replyTarget, rumor, timestamp, unwrapAsync, wrap, type DecodedEnvelope, type Identity, type Rumor } from './protocol.js';
import { createMessagingProtocol, protocolScope, type MessagingProtocol, type ProtocolMode } from './modes.js';
import { InboxSubscription, type ReconnectOptions, type RecoveryOptions } from './inbox.js';
import {
  validateCommandDefinition,
  type CommandDefinition,
  type DiscoverCommandsOptions,
} from './nipcd.js';
import { relayRoles, relayUnion, readWriteTags, type RelayRoles } from './relay-roles.js';
import { KeySync, type KeySyncOptions } from './key-sync.js';
import { MessagingMetadata, type MetadataCacheOptions } from './messaging-metadata.js';
import { Announcements } from './announcements.js';
import { discoverCommandCatalog } from './command-discovery.js';
import { CommandCatalog, type CommandSyncResult } from './commands.js';
import type { MessageState } from './storage.js';
import type { MessageStorage } from './message-storage.js';
import { EncryptionKeys, type AnnounceOptions, type KeyRotationOptions } from './keys.js';

export interface SendResult {
  id: string;
  status: 'relay-accepted' | 'pending';
}

export interface SendOptions {
  /** ID of the decrypted kind-14 message being replied to. */
  replyTo?: string;
}

export interface IntakeMetadata {
  relay?: string;
}

export interface CommonClientOptions {
  publicInbox?: PublicInboxOptions;
  metadataCache?: false | MetadataCacheOptions;
  keySync?: false | KeySyncOptions;
  /** Optional synchronous gate over the verified external sender, before persistence. */
  inboundPolicy?: InboundPolicy;
  nip4eCompatibility?: boolean;
  reconnect?: false | ReconnectOptions;
  recovery?: false | RecoveryOptions;
  relays?: string[];
  dmRelays?: string[];
  readRelays?: string[];
  writeRelays?: string[];
  discoveryRelays?: readonly string[];
  blossomServers?: readonly string[];
  blossomDownloadOrigins?: readonly string[];
  storageKey?: Uint8Array;
  historyLimit?: number;
  database?: string;
  messageStorage?: MessageStorage;
}

/** Invalid backend and protocol combinations are rejected before runtime in TypeScript. */
type ClientConfiguration = CommonClientOptions & ({
  transport: Transport;
  transportOptions?: never;
} | {
  transport?: undefined;
  transportOptions?: WebSocketTransportOptions;
}) & ({
  mode?: ProtocolMode;
  keyRotation?: false;
} | {
  mode: 'nip4e';
  keyRotation: KeyRotationOptions;
});

/** Account credentials are supplied only through signer capabilities. */
export type ClientOptions = ClientConfiguration & {
  signer: Signer;
};

export type CommandRegistration = (() => void) & { active(): boolean };

export type MessageHandler = (message: Message) => void | Promise<void>;

export type MessageObserver = (message: Readonly<Message>) => void | Promise<void>;

export type ErrorHandler = (error: unknown, message?: Message) => void | Promise<void>;

export class Client {
  readonly options: ClientConfiguration & RelayRoles & {
    relays: string[];
  };
  private metadataLookupRelays: string[];
  private readonly blossomServers: readonly string[];
  private readonly blossomDownloadOrigins: ReadonlySet<string>;
  private announcements: Announcements;
  private metadata: MessagingMetadata;
  private keySync?: KeySync;
  private commandDefinitions = new Map<string, {
    definition: CommandDefinition;
    manual?: boolean;
    refs: number;
  }>();
  private commands: CommandCatalog;
  private publicInbox?: PublicInbox;
  private publicHandlers=new Set<(input:PublicInput)=>Promise<void>>();
  private commandRevision = 0;
  private syncedCommandRevision = -1;
  private managesCommandCatalog = false;
  private commandSyncScheduled = false;
  private revokedCommands = new Set<string>();
  private synchronizing?: Promise<CommandSyncResult>;
  private announcing?: Promise<void>;
  private readonly coreStore: Store;
  private readonly account: Identity;


  readonly mode: ProtocolMode;
  readonly nip4eCompatibility: boolean;
  private readonly inboundPolicy?: InboundPolicy;
  private keys: EncryptionKeys;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private protocol: MessagingProtocol;
  private transport: Transport;
  private ownsTransport: boolean;
  private observers = new Set<MessageObserver>();
  private handlers = new Set<MessageHandler>();
  private errors = new Set<ErrorHandler>();
  private queues = new Map<string, Promise<void>>();
  private scheduled = new Set<string>();
  private intake: Promise<void> = Promise.resolve();
  private sub?: InboxSubscription;
  private running = false;
  private closed = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private generation = 0;
  private handlerContext = new AsyncLocalStorage<{
    active: boolean;
  }>();
  private flushing?: Promise<void>;

  get pubkey(): string {
    return this.account.pubkey;
  }

  /** Resolve the account asynchronously, regardless of local or remote signing. */
  static async create(options: ClientOptions): Promise<Client> {
    const { signer, ...configuration } = options;
    if ('identity' in options) {
      throw new TypeError('Client.create accepts signer, not identity');
    }
    if ('storage' in options) {
      throw new TypeError('Use messageStorage for custom message history');
    }
    const identity = await identityFromSigner(signer, {
      mode: options.mode ?? 'nip17'
    });
    return new Client({ ...configuration, identity });
  }

  private constructor(input: ClientConfiguration & { identity: Identity }) {
    const { identity, ...configuration } = input;
    const roles = relayRoles(configuration);
    this.blossomServers = normalizeBlossomServers(configuration.blossomServers);
    this.blossomDownloadOrigins = normalizeBlossomDownloadOrigins(configuration.blossomDownloadOrigins);
    const options = this.options = {
      ...configuration,
      ...roles,
      relays: roles.dmRelays
    };
    this.metadataLookupRelays = relayUnion(roles.readRelays, roles.writeRelays, roles.dmRelays);
    if (!hexKey(identity.pubkey) || !options.relays.length) {
      throw new Error('Identity and at least one relay required');
    }
    if (options.inboundPolicy !== undefined && typeof options.inboundPolicy !== 'function') {
      throw new TypeError('inboundPolicy must be a synchronous identity policy');
    }
    this.inboundPolicy = options.inboundPolicy;
    this.account = {
      ...identity, oldEncryptionKeys: identity.oldEncryptionKeys?.map(key => new Uint8Array(key))
    };
    if (options.nip4eCompatibility !== undefined && typeof options.nip4eCompatibility !== 'boolean') {
      throw new TypeError('nip4eCompatibility must be boolean');
    }
    this.mode = options.mode ?? 'nip17';
    const scope = protocolScope(this.mode, this.account);
    this.nip4eCompatibility = this.mode === 'nip4e' || options.nip4eCompatibility !== false;
    if (options.transport && options.transportOptions) {
      throw new TypeError('Choose transport or transportOptions, not both');
    }
    this.transport = options.transport ?? new WebSocketTransport(options.transportOptions ?? {}, template => this.account.sign(template));
    this.ownsTransport = !options.transport;
    if ('storage' in options) throw new TypeError('Internal storage accepts only a database path; use messageStorage for messages');
    this.coreStore = new Store(options.database ?? 'psstpsst.sqlite', options.storageKey, scope, options.messageStorage);
    try {
      this.metadata = new MessagingMetadata(this.account.pubkey, this.coreStore, this.transport, this.metadataLookupRelays, error => this.report(error), options.reconnect, options.metadataCache);
      this.keys = new EncryptionKeys(this.account, this.mode, this.coreStore, this.transport, this.metadataLookupRelays, options.keyRotation, [options.writeRelays, options.dmRelays], this.metadata);
      if (options.keySync !== false) {
        this.keySync = new KeySync(this.account, this.coreStore, this.transport, relayUnion(options.writeRelays, options.dmRelays), key => this.keys.exportEncryptionKey(key), () => this.coreStore.declaration(this.account.pubkey)?.tags.find(tag => tag[0] === 'n')?.[1], options.keySync);
        this.keys.setSynchronizer(key => this.keySync!.request(key));
        this.keys.onImported = () => {
          if (this.running && this.sub) {
            void this.sub.sync().catch(error => this.report(error));
          }
        };
        this.metadata.onOwnEvent = async (event) => {
          if (event.kind === 4454) {
            await this.keySync!.handle(event);
            return;
          }
          if (this.running) {
            await this.keys.prepare();
          }
        };
      }
      this.protocol = createMessagingProtocol(this.mode, this.account, this.keys, this.metadata, this.options.dmRelays);
      this.commands = new CommandCatalog(this.account, this.coreStore, this.transport, this.options.writeRelays);
      if(options.publicInbox)this.publicInbox=new PublicInbox(this.account,this.coreStore,this.transport,options.publicInbox,options.writeRelays,options.reconnect,()=>this.publicCommandDefinitions(),sender=>this.allowsSender(sender),async input=>{
        const context={active:true};try{await this.handlerContext.run(context,async()=>{for(const handler of this.publicHandlers)await handler(input);});}finally{context.active=false;}
      },error=>this.report(error));

      this.coreStore.recoverMessages();
      this.announcements = new Announcements(this.account, this.coreStore, this.transport, event => this.metadata.rememberOwn(event));
    }
    catch (error) {
      this.coreStore.close();
      if (this.ownsTransport) {
        this.transport.close();
      }
      throw error;
    }
  }

  /** Durable processing group: failures keep the message retryable. Register before start. */
  handle(handler: MessageHandler): () => void {
    this.assertOpen();
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Receipt observer only: failures cannot change inbox state or replay business work. */
  on(event: 'message', observer: MessageObserver): () => void {
    this.assertOpen();
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  onError(handler: ErrorHandler): () => void {
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }

  report(error: unknown, message?: Message) {
    for (const fn of this.errors) {
      try {
        void Promise.resolve(fn(error, message)).catch(() => {
        });
      }
      catch {
      }
    }
  }

  private assertOpen() {
    if (this.closed || this.closing) {
      throw new Error('Client is closed or closing');
    }
  }

  start(publishMetadata = false): Promise<void> {
    try {
      this.assertOpen();
    }
    catch (error) {
      return Promise.reject(error);
    }
    if (this.stopping) {
      return this.stopping.then(() => this.start(publishMetadata));
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.running) {
      return Promise.resolve();
    }
    this.running = true;
    const generation = ++this.generation;
    const task = this.startUp(generation, publishMetadata).finally(() => {
      if (this.starting === task) {
        this.starting = undefined;
      }
    });
    this.starting = task;
    return task;
  }

  private async startUp(generation: number, publishMetadata: boolean) {
    const current = () => this.running && this.generation === generation && !this.closing;
    try {
      this.coreStore.recoverMessages();
      this.keySync?.start();
      await this.metadata.start();
      if (!current()) {
        return;
      }
      // Complete publication before starting business subscriptions or replaying handlers.
      if (publishMetadata) await this.publishKeyMetadata();
      else await this.protocol.prepare();
      if (!current()) return;

      if (this.managesCommandCatalog) await this.syncCommands();
      if (!current()) return;

      if (publishMetadata) await this.publishMetadata();
      if (!current()) return;

      for (const m of this.coreStore.pending()) {
        this.enqueue(m);
      }
      this.sub = new InboxSubscription({
        transport: this.transport,
        store: this.coreStore,
        relays: this.options.relays,
        filter: {
          kinds: [1059],
          '#p': [this.account.pubkey],
          limit: this.options.historyLimit ?? 500
        },
        reconnect: this.options.reconnect,
        recovery: this.options.recovery,
        localReadWindow:true,
        receive: (event, source, relay) => this.receive(event, source, {
          relay
        }).then(() => {
        }),
        error: error => this.report(error),
        reconnected: () => this.flushOutbox(),
      });
      await this.sub.ready;
      await this.intake;
      if(current())await this.publicInbox?.start(this.publicKinds());
      if (current()) {
        await this.flushOutbox();
        if (!current()) {
          return;
        }
        await this.keys.rotateIfDue();
        this.scheduleRotation();

      }
    }
    catch (error) {
      // External stop waits for startup; startup failure must not wait on that same stop.
      if (this.generation === generation) {
        await this.drainStop(this.quiesce());
      }
      throw error;
    }
  }

  /** Verify and persist a relay event using the same asynchronous signer capabilities. */
  receive(event: Event, source: 'live' | 'history', metadata?: IntakeMetadata): Promise<boolean> {
    this.assertOpen();
    if([1,1111].includes(event.kind))return Promise.resolve().then(()=>this.publicInbox?.receive(event,source,metadata?.relay)??false);
    const boundary=localReadBoundary(event);
    const snapshot = metadata ? {
      relay: metadata.relay
    } : undefined;
    // Preserve wire intake order even when remote decrypt calls complete at different speeds.
    const task = this.intake.then(async () => {
      const decoded = await unwrapAsync(event, this.account, this.protocol.envelope);
      return decoded ? this.accept(decoded,source==='history'&&boundary!==undefined&&decoded.rumor.created_at>boundary?'live':source,snapshot) : false;
    });
    this.intake = task.then(() => {
    }, () => {
    });
    return task;
  }

  private accept(decoded: DecodedEnvelope, source: 'live' | 'history', metadata?: IntakeMetadata): boolean {
    const r = decoded.rumor, own = r.pubkey === this.account.pubkey;
    // decode has verified both signatures, rumor hash and equality with the signed seal author.
    if (!own && !this.allowsSender(r.pubkey)) {
      return false;
    }
    const replyTo = replyTarget(r);
    const message: Message = {
      id: r.id,
      sender: r.pubkey,
      conversation: own ? r.tags.find(t => t[0] === 'p')![1] : r.pubkey,
      text: r.content,
      timestamp: timestamp(r),
      source,
      direction: own ? 'outgoing' : 'incoming',
      rumor: r,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(metadata?.relay ? {
        relay: metadata.relay
      } : {})
    };
    let inserted = false;
    this.coreStore.transaction(() => {
      this.protocol.remember(decoded, this.coreStore);
      inserted = this.coreStore.insert(message);
    });
    if (source === 'live' && !own && this.running && (inserted || this.coreStore.messageState(message.id) === 'pending')) {
      this.enqueue(message);
    }
    if (inserted && source === 'live' && !own && this.running) {
      // Notify once per receipt, using detached copies outside the durable processing group.
      for (const observer of this.observers) {
        try {
          void Promise.resolve(observer(structuredClone(message))).catch(error => this.report(error, structuredClone(message)));
        }
        catch (error) {
          this.report(error, structuredClone(message));
        }
      }
    }
    return inserted;
  }

  private allowsSender(identity: string) {
    const policy = this.inboundPolicy;
    if (policy === undefined) return true;
    const accepted = policy(identity);
    if (typeof accepted !== 'boolean') {
      // JavaScript callers cannot accidentally authorize with a Promise or truthy value.
      void Promise.resolve(accepted).catch(() => {});
      throw new TypeError('inboundPolicy must return a boolean synchronously');
    }
    return accepted;
  }

  private enqueue(message: Message) {
    // Encrypted pending records were authenticated on receipt. Recheck the saved identity,
    // including sender/rumor consistency, before any listener, middleware or session access.
    if (message.direction !== 'incoming' || message.sender !== message.rumor.pubkey || message.sender === this.account.pubkey || !this.allowsSender(message.rumor.pubkey)) {
      this.coreStore.state(message.id, 'done');
      return; // Consume previously accepted work revoked by new configuration.
    }
    if (this.scheduled.has(message.id)) {
      return;
    }
    this.scheduled.add(message.id);
    const previous = this.queues.get(message.conversation) ?? Promise.resolve();
    const next = previous.catch(() => {
    }).then(async () => {
      this.coreStore.state(message.id, 'processing');
      try {
        const context = {
          active: true
        };
        try {
          await this.handlerContext.run(context, async () => {
            for (const handler of this.handlers) {
              await handler(message);
            }
          });
        }
        finally {
          context.active = false;
        }
        this.coreStore.state(message.id, 'done');
      }
      catch (e) {
        this.coreStore.state(message.id, 'failed');
        this.report(e, message);
      }
    }).catch(error => this.report(error, message));
    this.queues.set(message.conversation, next);
    void next.finally(() => {
      this.scheduled.delete(message.id);
      if (this.queues.get(message.conversation) === next) {
        this.queues.delete(message.conversation);
      }
    });
  }

  async idle() {
    this.assertOutsideHandler('idle()');
    await this.drainInbox();
    await this.publicInbox?.idle();
  }

  private async drainInbox() {
    for (;;) {
      const intake = this.intake;
      await intake;
      await Promise.all(this.queues.values());
      if (this.intake === intake && this.queues.size === 0) {
        return;
      }
    }
  }

  async retryInbox(options: {
    ids?: readonly string[];
  } = {}) {
    this.assertOpen();
    this.assertOutsideHandler('retryInbox()');
    if (options.ids && (!Array.isArray(options.ids) || !options.ids.every(hexKey))) {
      throw new TypeError('Invalid retry message IDs');
    }
    const ids = options.ids ? new Set(options.ids) : undefined;
    await this.idle();
    for (const message of this.coreStore.pending()) {
      if (!ids || ids.has(message.id)) {
        this.enqueue(message);
      }
    }
    this.publicInbox?.retry(ids);
    await this.idle();
  }

  getMessage(id: string, peer?: string): Message | undefined {
    this.assertOpen();
    if (!hexKey(id)) throw new TypeError('Invalid message ID');
    return this.coreStore.getMessage(id, peer);
  }

  getMessageState(id: string): MessageState | undefined {
    this.assertOpen();
    if (!hexKey(id)) {
      throw new TypeError('Invalid message ID');
    }
    return this.coreStore.messageState(id);
  }

  listMessages(options?: import('./store.js').MessageListOptions) {
    this.assertOpen();
    return this.coreStore.listMessages(options);
  }

  // Closing rejects new work, but a draining handler must still commit its session.
  private assertSessionOpen() {
    if (this.closed || (this.closing && !this.handlerContext.getStore()?.active)) {
      throw new Error('Client is closed or closing');
    }
  }

  getSession<T>(peer: string): T | undefined {
    this.assertSessionOpen();
    if (!hexKey(peer)) {
      throw new TypeError('Invalid session peer');
    }
    return this.coreStore.session<T>(peer);
  }

  setSession(peer: string, value: unknown): void {
    this.assertSessionOpen();
    if (!hexKey(peer)) {
      throw new TypeError('Invalid session peer');
    }
    this.coreStore.saveSession(peer, value);
  }

  assertOutsideHandler(operation = 'stop() or close()') {
    if (this.handlerContext.getStore()?.active) {
      throw new Error(`Cannot await ${operation} inside a message handler; drain outside the handler and use requestStop() for shutdown`);
    }
  }

  private quiesce(): Promise<void> {
    this.running = false;
    this.generation++;
    this.keySync?.stop();
    clearTimeout(this.rotationTimer);
    this.rotationTimer = undefined;
    this.sub?.close();
    this.sub = undefined;
    this.publicInbox?.stop();
    // Cancel an initial metadata read before waiting for startup to finish.
    const metadata = this.metadata.stop();
    void metadata.catch(() => {
    });
    return metadata;
  }

  private async drainStop(metadata: Promise<void>) {
    await this.drainInbox();
    await this.publicInbox?.idle();
    if (this.flushing) {
      await this.flushing.catch(() => {
      });
    }
    await this.keys.idle();
    await this.announcing?.catch(() => {
    });
    await this.announcements.idle();
    await this.synchronizing?.catch(() => {});
    await this.commands.idle();
    await metadata;
    await this.keySync?.idle();
  }

  private stopInternal(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    const startup = this.starting, metadata = this.quiesce();
    const task = (async () => {
      await startup?.catch(() => {
      });
      await this.drainStop(metadata);
    })()
      .finally(() => {
      if (this.stopping === task) {
        this.stopping = undefined;
      }
    });
    this.stopping = task;
    return task;
  }

  /** Handler-safe stop request; await stop() outside handlers to drain current work. */
  requestStop(): void {
    this.assertOpen();
    void this.stopInternal().catch(error => this.report(error));
  }

  async stop() {
    this.assertOutsideHandler();
    await this.stopInternal();
  }

  close(): Promise<void> {
    try {
      this.assertOutsideHandler();
    }
    catch (error) {
      return Promise.reject(error);
    }
    if (this.closing) {
      return this.closing;
    }
    if (this.closed) {
      return Promise.resolve();
    }
    const task = Promise.resolve().then(async () => {
      await this.stopInternal();
      try {
        if (this.ownsTransport) {
          this.transport.close();
        }
      }
      finally {
        try {
          this.coreStore.close();
        }
        finally {
          this.closed = true;
        }
      }
    });
    this.closing = task;
    return task;
  }

  async syncHistory() {
    this.assertOpen();
    if (!this.sub || !this.running) {
      throw new Error('Start the client before synchronizing history');
    }
    return this.sub.sync();
  }

  history(peer: string, options?: {
    limit?: number;
    cursor?: string;
  }) {
    this.assertOpen();
    return this.coreStore.history(peer, options);
  }


  /** Rebind an unsigned rumor only to this account's authenticated incoming record. */
  private authenticatedInput(event: Event | Rumor): Message | PublicInput {
    let snapshot: Event | Rumor;
    try {snapshot=structuredClone(event);} catch {throw new TypeError('Expected an authenticated input event');}
    if(!snapshot || typeof snapshot!=='object')throw new TypeError('Expected an input event, not an ID');
    if(snapshot.kind===1 || snapshot.kind===1111){
      if(!this.publicInbox)throw new Error('Public inbox is not configured');
      return this.publicInbox.target(snapshot as Event);
    }
    if(snapshot.kind!==14 || 'sig' in snapshot || !hexKey(snapshot.id))throw new TypeError('Expected a signed kind 1/1111 event or authenticated kind 14 rumor');
    const message=this.coreStore.getMessage(snapshot.id);
    const canonical=(input:Event|Rumor)=>JSON.stringify([input.id,input.pubkey,input.kind,input.created_at,input.tags,input.content]);
    const recipients=Array.isArray(snapshot.tags)?snapshot.tags.filter(tag=>Array.isArray(tag)&&tag[0]==='p'):[];
    try {
      if(!message || message.direction!=='incoming' || message.sender===this.pubkey ||
        message.sender!==snapshot.pubkey || message.conversation!==snapshot.pubkey ||
        recipients.length!==1 || recipients[0][1]!==this.pubkey ||
        snapshot.id!==getEventHash(snapshot) || canonical(snapshot)!==canonical(message.rumor) ||
        message.id!==snapshot.id || message.text!==snapshot.content || message.timestamp!==timestamp(snapshot) ||
        message.replyTo!==replyTarget(snapshot))throw new Error();
    }catch {throw new TypeError('DM input does not match an authenticated incoming record for this account');}
    return structuredClone(message!);
  }

  /** Application-owned delayed work uses the exact event exposed by ctx.input.event. */
  async reply(event:Event|Rumor,text:string,options?:SendOptions):Promise<SendResult>{
    this.assertOpen();
    const target=this.authenticatedInput(event);
    if('rumor' in target)return this.send(target.conversation,text,options);
    if(options&&Object.keys(options).length)throw new TypeError('DM send options are not valid for public replies');
    return this.replyPublic(target,text);
  }

  async replyFile(event: Event | Rumor, data: Uint8Array, options: ReplyFileOptions = {}): Promise<SendResult> {
    this.assertOpen();
    const target = this.authenticatedInput(event);
    if ('rumor' in target) {
      return this.sendFile(target.conversation, data, { ...options, replyTo: target.id });
    }
    const { mimeType } = options;
    const bytes = snapshotFile(data);
    return this.publicInbox!.replyFile(target, async () => {
      const result = await this.uploadFile(bytes, { mimeType });
      this.assertOpen();
      return result;
    });
  }

  async thread(event:Event|Rumor,options?:ThreadOptions):Promise<ThreadResult>{
    this.assertOpen();
    const target=this.authenticatedInput(event);
    return 'rumor' in target?this.threadPrivate(target,options):this.threadPublic(target,options);
  }

  private publicKinds(){return [...new Set(this.publicCommandDefinitions().flatMap(definition=>(definition.scopes??[]).filter(scope=>scope==='kind:1'||scope==='kind:1111').map(scope=>Number(scope.slice(5)))))];}
  handlePublic(handler:(input:PublicInput)=>Promise<void>){this.publicHandlers.add(handler);return()=>{this.publicHandlers.delete(handler);};}
  replyPublic(input:PublicInput,text:string){this.assertOpen();if(!this.publicInbox)throw new Error('Public inbox is not configured');return this.publicInbox.reply(input,text);}
  threadPublic(input:PublicInput,options?:ThreadOptions){this.assertOpen();if(!this.publicInbox)throw new Error('Public inbox is not configured');return this.publicInbox.thread(input,options);}
  getPublicSession<T>(key:string){this.assertSessionOpen();return this.coreStore.metadata<T>(`public-session:${key}`);}
  setPublicSession(key:string,value:unknown){this.assertSessionOpen();this.coreStore.saveMetadata(`public-session:${key}`,value);}
  async threadPrivate(message:Message,options:ThreadOptions={}):Promise<ThreadResult>{
    const limit=threadLimit(options.limit);let cursor:string|undefined;const prior:Message[]=[];
    for(let page=0;page<10&&prior.length<=limit;page++){
      const history=this.history(message.conversation,{limit:100,cursor});
      prior.push(...history.messages.filter(item=>item.id!==message.id&&(item.timestamp<message.timestamp||(item.timestamp===message.timestamp&&item.id<message.id))));
      cursor=history.nextCursor;if(!cursor)break;
    }
    return{entries:prior.slice(0,limit).reverse().map(item=>inputOf(item.rumor)),complete:false,coverage:'local-conversation',reason:'local-only'};
  }

  /** Register one public command coordinate. Startup reconciles the complete local set. */
  registerCommandDefinition(definition: CommandDefinition): CommandRegistration {
    this.assertOpen();
    if (arguments.length > 1) throw new TypeError('Commands are always public on configured write relays');
    this.managesCommandCatalog = true;
    const snapshot = validateCommandDefinition(definition);
    if(snapshot.scopes?.some(scope=>scope==='kind:1'||scope==='kind:1111')&&!this.publicInbox)throw new TypeError('Public commands require explicit publicInbox.relays');
    const old = this.commandDefinitions.get(snapshot.id);
    if (old && JSON.stringify(old.definition) !== JSON.stringify(snapshot)) throw new TypeError('Conflicting command coordinate');
    const entry = old ?? {definition:snapshot, refs:0};
    entry.refs++;
    this.commandDefinitions.set(snapshot.id, entry);
    this.revokedCommands.delete(snapshot.id);
    this.commandRevision++;
    this.scheduleCommandSync();
    let removed = false;
    const unregister = () => {
      if (removed) return;
      removed = true;
      if (this.commandDefinitions.get(snapshot.id) === entry && --entry.refs === 0 && !entry.manual) {
        this.commandDefinitions.delete(snapshot.id);
        this.commandRevision++;
        this.scheduleCommandSync();
      }
    };
    return Object.assign(unregister, {active: () => !removed && this.commandDefinitions.get(snapshot.id) === entry});
  }

  /** Claim the bot-owned command catalog, including an intentionally empty registry. */
  manageCommands(): void { this.assertOpen(); this.managesCommandCatalog = true; this.scheduleCommandSync(); }

  hasCommand(id: string): boolean { return this.commandDefinitions.has(id); }

  private publicCommandDefinitions() {
    return [...this.commandDefinitions.values()].map(entry => structuredClone(entry.definition));
  }

  private scheduleCommandSync() {
    if (!this.running || this.closing || this.commandSyncScheduled) return;
    this.commandSyncScheduled = true;
    queueMicrotask(() => {
      this.commandSyncScheduled = false;
      if (this.running && !this.closing) void this.syncCommands().catch(error => this.report(error));
    });
  }

  /** Synchronize public definitions and NIP-09 withdrawals on write relays. */
  syncCommands(): Promise<CommandSyncResult> {
    this.assertOpen();
    this.managesCommandCatalog = true;
    if (this.synchronizing) return this.synchronizing;
    const generation = this.generation;
    const active = () => !this.closed && !this.closing && this.generation === generation;
    const task = (async () => {
      // Net presence changes across every completed round in this coalesced operation.
      const changes=new Map<string,{initial:boolean;current:boolean}>();
      for (;;) {
        const revision = this.commandRevision, removals = [...this.revokedCommands];
        const result = await this.commands.sync(this.publicCommandDefinitions(), removals, active);
        for(const category of ['added','updated','removed'] as const){
          for(const id of result[category]){
            const change=changes.get(id)??{initial:category!=='added',current:false};
            change.current=category!=='removed';changes.set(id,change);
          }
        }
        for (const id of removals) if (!this.commandDefinitions.has(id)) this.revokedCommands.delete(id);
        if (this.commandRevision === revision) {
          if(this.running&&this.sub)await this.publicInbox?.start(this.publicKinds());
          // Registration can change while the new public subscription waits for EOSE.
          if(!active())throw new Error('Command synchronization canceled');
          if(this.commandRevision!==revision)continue;
          this.syncedCommandRevision = revision;
          const combined:CommandSyncResult={added:[],updated:[],removed:[]};
          for(const[id,change]of changes){
            if(change.current)combined[change.initial?'updated':'added'].push(id);
            else if(change.initial)combined.removed.push(id);
          }
          return combined;
        }
      }
    })().finally(() => { if (this.synchronizing === task) this.synchronizing = undefined; });
    this.synchronizing = task;
    return task;
  }

  announce(options: AnnounceOptions = {}): Promise<void> {
    this.assertOpen();
    if (this.announcing) {
      return this.announcing.then(() => this.announce(options));
    }
    const task = (async () => {
      this.coreStore.recoverMessages();
      this.keySync?.start();
      await this.metadata.start();
      await this.publishKeyMetadata(options);
      if (this.managesCommandCatalog) await this.syncCommands();
      await this.publishMetadata();
    })().finally(() => {
      if (this.announcing === task) {
        this.announcing = undefined;
      }
    });
    this.announcing = task;
    return task;
  }

  private async publishKeyMetadata(options?: AnnounceOptions) {
    if (this.nip4eCompatibility) await this.keys.announce(options);
    else await this.keys.prepare();
  }

  // Discovery metadata can fail independently of inbox availability and key custody.
  private async publishMetadata() {
    const created_at = Math.floor(Date.now() / 1000);
    const { writeRelays, dmRelays, discoveryRelays } = this.options;
    await this.announcements.publish([
      {
        template: {
          kind: 10002,
          created_at,
          tags: readWriteTags(this.options.readRelays, this.options.writeRelays),
          content: ''
        }, groups: [writeRelays], optionalRelays: discoveryRelays
      },
      {
        template: {
          kind: 10050,
          created_at,
          tags: this.options.dmRelays.map(url => ['relay', url]),
          content: ''
        }, groups: [writeRelays, dmRelays], optionalRelays: discoveryRelays
      },
      ...(this.blossomServers.length ? [{
        template: { kind: 10063, created_at, tags: this.blossomServers.map(url => ['server', url]), content: '' },
        groups: [writeRelays], optionalRelays: discoveryRelays,
      }] : []),
    ]);
  }

  /** Retry exact persisted public metadata; it does not register/execute discovered commands. */
  async flushAnnouncements() {
    this.assertOpen();
    const pendingKey = !!this.keys.status().pending;
    if (pendingKey) {
      await this.keys.prepare();
    }
    // Background retries should not poll every relay once the registry has converged.
    if (this.managesCommandCatalog && (this.syncedCommandRevision !== this.commandRevision || this.commands.hasPending())) {
      await this.syncCommands();
    }
    if (pendingKey || this.announcements.hasPending()) {
      await this.publishMetadata();
    }
  }

  encryptionKeys() {
    this.assertOpen();
    return this.keys.status();
  }

  async rotateEncryptionKey() {
    this.assertOpen();
    await this.keys.rotate();
    this.scheduleRotation();
    return this.keys.status();
  }

  private scheduleRotation() {
    clearTimeout(this.rotationTimer);
    if (!this.running) {
      return;
    }
    const delay = this.keys.nextDelay();
    if (delay === undefined) {
      return;
    }
    this.rotationTimer = setTimeout(() => {
      void this.keys.rotateIfDue().catch(error => this.report(error)).finally(() => this.scheduleRotation());
    }, delay);
    this.rotationTimer.unref();
  }

  async refreshPeer(peer: string): Promise<{
    encryptionPubkey: string;
    relays: string[];
  }> {
    this.assertOpen();
    const metadata = await this.protocol.resolve(peer, this.coreStore, this.transport, this.metadataLookupRelays, true);
    return {
      encryptionPubkey: metadata.encryptionPubkey, relays: metadata.relays
    };
  }

  async publishCommand(definition: CommandDefinition) {
    this.assertOpen();
    if (arguments.length > 1) throw new TypeError('Commands are always public on configured write relays');
    this.managesCommandCatalog = true;
    const snapshot = validateCommandDefinition(definition), old = this.commandDefinitions.get(snapshot.id);
    if (old && old.refs > 0 && JSON.stringify(old.definition) !== JSON.stringify(snapshot)) throw new TypeError('Replace the registered Bot command before publishing a changed definition');
    if (old) {
      old.definition = snapshot;
      old.manual = true;
    } else {
      this.commandDefinitions.set(snapshot.id, { definition: snapshot, refs: 0, manual: true });
    }
    this.revokedCommands.delete(snapshot.id);
    this.commandRevision++;
    await this.syncCommands();
    return {event:this.commands.definition(snapshot.id)!,status:'relay-accepted' as const};
  }

  async revokeCommand(id: string) {
    this.assertOpen();
    if (arguments.length > 1) throw new TypeError('Commands are always public on configured write relays');
    this.managesCommandCatalog = true;
    if (typeof id !== 'string') throw new TypeError('Invalid command ID');
    this.commandDefinitions.delete(id);
    this.revokedCommands.add(id);
    this.commandRevision++;
    await this.syncCommands();
    return {event:this.commands.revocation(id)!,status:'relay-accepted' as const};
  }

  async discoverCommands(options: DiscoverCommandsOptions) {
    this.assertOpen();
    return discoverCommandCatalog(this.transport, options);
  }

  async send(peer: string, text: string, { replyTo }: SendOptions = {}): Promise<SendResult> {
    this.assertOpen();
    if (typeof text !== 'string' || !text.length) {
      throw new Error('Nonempty text required');
    }
    if (replyTo !== undefined && !hexKey(replyTo)) {
      throw new TypeError('replyTo must be a lowercase hex message ID');
    }
    const r = rumor(this.account.pubkey, peer, text, undefined, replyTo);
    const message: Message = {
      id: r.id,
      sender: r.pubkey,
      conversation: peer,
      text,
      timestamp: timestamp(r),
      source: 'live',
      direction: 'outgoing',
      rumor: r,
      ...(replyTo === undefined ? {} : { replyTo }),
    };
    return this.publishPrivate(peer, r, message);
  }

  async uploadFile(data: Uint8Array, options?: UploadFileOptions): Promise<UploadFileResult> {
    this.assertOpen();
    return uploadFile(this.account, this.blossomServers, this.blossomDownloadOrigins, data, options);
  }

  async sendFile(peer: string, data: Uint8Array, options: SendFileOptions = {}): Promise<SendResult> {
    this.assertOpen();
    if (!this.blossomServers.length) throw new Error('Configure blossomServers before sending files');
    if (!hexKey(peer)) throw new TypeError('Expected a lowercase hex recipient pubkey');
    const { replyTo } = options;
    if (replyTo !== undefined && !hexKey(replyTo)) throw new TypeError('replyTo must be a lowercase hex message ID');
    const { bytes, tags } = encryptAttachment(data, options);
    await this.protocol.prepare();
    this.assertOpen();
    const { url, sha256, size } = await this.uploadFile(bytes);
    this.assertOpen();
    const r = fileRumor(this.account.pubkey, peer, url, [...tags, ['x', sha256], ['size', String(size)]], replyTo);
    return this.publishPrivate(peer, r, {
      id: r.id, sender: r.pubkey, conversation: peer, text: '',
      timestamp: timestamp(r), source: 'live', direction: 'outgoing', rumor: r,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
  }

  async react(id: string, reaction = '+', peer?: string): Promise<SendResult> {
    this.assertOpen();
    if (typeof reaction !== 'string' || !reaction.trim()) {
      throw new TypeError('Nonempty reaction required');
    }
    const target = this.getMessage(id, peer);
    if (!target) throw new Error('Reaction target was not found in local message history');

    const r = reactionRumor(this.account.pubkey, target.conversation, target.id, reaction);
    return this.publishPrivate(target.conversation, r);
  }

  private async publishPrivate(peer: string, r: Rumor, message?: Message): Promise<SendResult> {
    const recipients = await this.protocol.recipients(peer, this.coreStore, this.transport, this.metadataLookupRelays);
    const sendingIdentity = {
      ...this.account, oldEncryptionKeys: this.account.oldEncryptionKeys?.slice()
    };
    const events: {
      event: Event;
      relays: string[];
    }[] = [];
    for (const recipient of recipients) {
      events.push({
        event: await wrap(r, sendingIdentity, recipient.pubkey, recipient.encryptionPubkey, recipient.envelope ?? this.protocol.envelope),
        relays: recipient.relays,
      });
    }
    this.coreStore.transaction(() => {
      if (message) this.coreStore.insert(message);
      this.coreStore.putOutbox(r.id, events);
    });
    try {
      await this.flushOutbox();
    }
    catch (error) {
      this.report(error);
    }
    return {
      id: r.id, status: this.coreStore.outbox().some(item => item.id === r.id) ? 'pending' : 'relay-accepted'
    };
  }

  flushOutbox(): Promise<void> {
    this.assertOpen();
    // A caller arriving during a flush may have just committed a newer outbox row.
    if (this.flushing) {
      return this.flushing.catch(() => {
      }).then(() => this.flushOutbox());
    }
    this.flushing = (async () => {
      const pending = this.coreStore.outbox();
      if (pending.length) {
        await this.protocol.prepare();
      }
      const errors: unknown[] = [];
      for (const item of pending) {
        try {
          for (const envelope of item.events) {
            await this.transport.publish(envelope.relays, envelope.event);
          }
          this.coreStore.ack(item.id);
        }
        catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, 'Some outbox messages remain pending');
      }
      await this.publicInbox?.flush();
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
}
