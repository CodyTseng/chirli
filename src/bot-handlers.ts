import {z} from 'zod';
import {markDeferredRequestFailure} from './request-timing.js';
import {commandArguments} from './command-schema.js';
import {InvalidArgsError} from './errors.js';
import {inputOf, type Input, type ThreadOptions, type ThreadResult} from './public-thread.js';
import type {PublicInput} from './public-inbox.js';
import type {Event} from 'nostr-tools';
import type {Rumor} from './protocol.js';
import { messageSession, type Session, type SessionStore } from './session.js';
import { Client, type CommandRegistration, type SendOptions } from './client.js';
import type { Message } from './store.js';
import {parseCommandHead,matchesCommandScopes, parseCommand, validateCommandDefinition, type BotCommandDefinition, type CommandArgs, type CommandDefinition, type CommandInvocation } from './nipcd.js';

export interface Context<S = Record<string, unknown>> {
  input: Input;
  thread(options?:ThreadOptions):Promise<ThreadResult>;
  /** DM-only compatibility view; throws for public input. */
  message: Message;
  sender: string;
  conversation: string;
  reply(text: string, options?: SendOptions): ReturnType<Client['send']> | ReturnType<Client['replyPublic']>;
  /** React to the current message or another message in this conversation. */
  react(reaction?: string, messageId?: string): ReturnType<Client['react']>;
  /** Look up a locally stored message in this conversation. */
  getMessage(id: string): Message | undefined;
  history(options?: {
    limit?: number;
    cursor?: string;
  }): ReturnType<Client['history']>;
  session: Session<S>;
}

export interface CommandContext<A,S=Record<string,unknown>> extends Context<S>{readonly args:A}

export type Next = () => Promise<void>;

export type Middleware<S = Record<string, unknown>> = (ctx: Context<S>, next: Next) => unknown | Promise<unknown>;

export type MessageHandler<S = Record<string, unknown>> = (ctx: Context<S>) => unknown;

export type CommandHandler<D extends BotCommandDefinition, S = Record<string, unknown>> =
  (ctx: CommandContext<CommandArgs<D>,S>, args: CommandArgs<D>) => unknown;

export interface BotCommandOptions<S = Record<string, unknown>, D extends BotCommandDefinition = BotCommandDefinition> {
  /** Fallback public metadata; fields on the definition take precedence. */
  title?: string;
  description?: string;
  authorize?: (ctx: Context<S>, invocation: CommandInvocation<CommandArgs<D>>) => boolean | Promise<boolean>;
}

export class BotHandlers<S = Record<string, unknown>> {
  private middleware: Middleware<S>[] = [];
  private fallback?: MessageHandler<S>;
  private definitions = new Map<string, CommandDefinition>();
  private errorHandler?: (error: unknown, ctx: Context<S>) => unknown | Promise<unknown>;
  private detach?: () => void;
  private detachPublic?: () => void;
  private validatorFailures=new WeakMap<Context<S>,{error:unknown}>();
  private invalidArgs = new WeakMap<Context<S>,InvalidArgsError>();
  private argumentError(ctx:Context<S>,error:InvalidArgsError){this.invalidArgs.set(ctx,error);return error;}
  private routing = new WeakMap<Context<S>,{event:Event|Rumor;relay?:string}>();
  private disposed = false;
  private boundClient?: Client;

  get client(): Client {
    if (!this.boundClient) throw new Error('Bot handlers are not attached');
    return this.boundClient;
  }
  private releaseDefinitions = new Map<string, CommandRegistration>();
  private commandHandlers = new Map<string, (ctx: Context<S>, executor: string) => Promise<boolean>>();

  constructor(client?: Client, private readonly options: { sessionStore?: SessionStore<S> } = {}) {
    if (client) this.attach(client);
  }

  attach(client: Client) {
    this.boundClient = client;
    client.manageCommands();
    for (const definition of this.definitions.values()) {
      this.releaseDefinitions.set(definition.id, client.registerCommandDefinition(definition));
    }
    this.detach = client.handle(message => this.dispatchMessage(client, message));
    this.detachPublic = client.handlePublic(input => this.dispatchPublic(client,input));
  }

  private assertActive() {
    if (this.disposed) {
      throw new Error('Bot is disposed');
    }
  }

  use(fn: Middleware<S>) {
    this.assertActive();
    this.middleware.push(fn);
    return this;
  }

  private register(definition: CommandDefinition) {
    if (this.definitions.has(definition.id)) throw new TypeError('Duplicate local command definition id');
    if (this.boundClient) this.releaseDefinitions.set(definition.id, this.client.registerCommandDefinition(definition));
    this.definitions.set(definition.id, definition);
  }

  /** All definitions are public on configured write relays. Authorization stays separate. */
  command<const D extends BotCommandDefinition>(
    command: D,
    fn: CommandHandler<NoInfer<D>, S>,
    options: BotCommandOptions<S, NoInfer<D>> = {},
  ) {
    this.assertActive();
    if ('publish' in options) throw new TypeError('Commands are always public');
    if ('id' in options || (typeof command === 'object' && command !== null && 'id' in command)) throw new TypeError('Custom command id is not supported; the command name determines its published identifier');
    const { title, description, authorize } = options;
    if(typeof command !== 'object' || command === null)throw new TypeError('Use a command definition with explicit scopes');
    const schema=command.args??z.object({});
    const definition: CommandDefinition = { ...command, args:commandArguments(schema), id: command.command, title:command.title??title??command.command, description:command.description??description??`Run /${command.command}.` };
    const snapshot = validateCommandDefinition(definition);
    const kinds=(snapshot.scopes??[]).filter(scope=>scope.startsWith('kind:'));
    if(!kinds.length || kinds.some(scope=>!['kind:14','kind:1','kind:1111'].includes(scope)) || new Set(kinds).size!==kinds.length)throw new TypeError('Commands require distinct supported kind scopes: kind:14, kind:1, kind:1111');
    this.register(snapshot);
    this.commandHandlers.set(snapshot.id, async (ctx, executor) => {
      if (this.definitions.get(snapshot.id) !== snapshot || !this.releaseDefinitions.get(snapshot.id)?.active()) {
        return false;
      }
      const routing=this.routing.get(ctx)!;
      const head=parseCommandHead(routing.event.content,snapshot.command,executor);
      if(head.status!=='matched'||!matchesCommandScopes(snapshot.scopes??[],routing.event,{relay:routing.relay}))return false;
      const parsed = parseCommand(snapshot,routing.event,{executor,relay:routing.relay});
      // An args-dependent authorization cannot authorize an error response for malformed input.
      if(parsed.status!=='matched'){
        if(authorize)return true;
        throw this.argumentError(ctx,new InvalidArgsError(snapshot.command,'decode'));
      }
      let validated:Awaited<ReturnType<typeof schema.safeParseAsync>>;
      try {validated=await schema.safeParseAsync(parsed.invocation.args);}
      catch(error){
        if(!authorize)throw error;
        this.validatorFailures.set(ctx,{error});
        markDeferredRequestFailure(ctx);
        return true;
      }
      if(!validated.success){
        if(authorize)return true;
        const names=new Set((snapshot.args??[]).map(argument=>argument.name));
        const codes=new Set(['invalid_type','too_small','too_big','invalid_format','invalid_value','custom','unrecognized_keys','invalid_union','not_multiple_of']);
        throw this.argumentError(ctx,new InvalidArgsError(snapshot.command,'validation',validated.error.issues.slice(0,20).map(issue=>({code:codes.has(issue.code)?issue.code:'custom',path:typeof issue.path[0]==='string'&&names.has(issue.path[0])?[issue.path[0]]:[]}))));
      }
      const args=validated.data as CommandArgs<D>;
      const invocation={...parsed.invocation,args} as CommandInvocation<CommandArgs<D>>;
      if(!authorize||await authorize(ctx,invocation)){
        const descriptors=Object.getOwnPropertyDescriptors(ctx);
        descriptors.args={value:args,enumerable:true,configurable:false,writable:false};
        const commandContext=Object.create(Object.getPrototypeOf(ctx),descriptors) as CommandContext<CommandArgs<D>,S>;
        await fn(commandContext,args);
      }
      // A matched command owns the route even when its authorization denies execution.
      return true;
    });
    return this;
  }

  getCommandDefinitions(): CommandDefinition[] {
    return structuredClone([...this.definitions.values()].filter(definition => !this.boundClient || this.releaseDefinitions.get(definition.id)?.active()));
  }

  /** Register the handler for messages with no matching command. */
  handle(fn: MessageHandler<S>): () => void {
    this.assertActive();
    if (this.fallback) throw new Error('A message handler is already registered');
    const fallback: MessageHandler<S> = ctx => fn(ctx);
    this.fallback = fallback;
    return () => {
      if (this.fallback === fallback) this.fallback = undefined;
    };
  }

  catch(fn: (error: unknown, ctx: Context<S>) => unknown | Promise<unknown>) {
    this.errorHandler = fn;
    return this;
  }

  sessionStore(client: Client): SessionStore<S> {
    return this.options.sessionStore ?? {
      get: peer => client.getSession<Partial<S>>(peer),
      set: (peer, value) => client.setSession(peer, value),
    };
  }

  private async dispatchMessage(client: Client, message: Message) {
    if (this.disposed) {
      return;
    }
    const anchor=structuredClone(message.rumor);
    const { session, commit } = messageSession(this.sessionStore(client), message.conversation);
    const ctx: Context<S> = {
      session,
      input:inputOf(message.rumor),
      thread:options=>client.thread(anchor,options),
      message,
      sender: message.sender,
      conversation: message.conversation,
      reply: (text, options) => client.reply(anchor,text,options),
      react: (reaction, id = message.id) => client.react(id, reaction, message.conversation),
      getMessage: id => client.getMessage(id, message.conversation),
      history: options => client.history(message.conversation, options)
    };
    return this.dispatch(client,ctx,commit,message.rumor,message.relay);
  }

  private async dispatchPublic(client:Client,input:PublicInput){
    if(this.disposed)return;
    const anchor=structuredClone(input.event);
    const store:SessionStore<S>=this.options.sessionStore??{get:key=>client.getPublicSession<Partial<S>>(key),set:(key,value)=>client.setPublicSession(key,value)};
    const {session,commit}=messageSession(store,input.conversation);
    const privateOnly=():never=>{throw new Error('This compatibility method is only available for direct messages; use input and thread');};
    const ctx:Context<S>={input:inputOf(input.event),sender:input.event.pubkey,conversation:input.conversation,session,
      get message(){return privateOnly();},
      reply:(text,options)=>client.reply(anchor,text,options),
      thread:options=>client.thread(anchor,options),react:privateOnly,getMessage:privateOnly,history:privateOnly};
    return this.dispatch(client,ctx,commit,input.event,input.relay);
  }

  private async dispatch(client:Client,ctx:Context<S>,commit:()=>Promise<void>,event:Event|Rumor,relay?:string){
    this.routing.set(ctx,{event:structuredClone(event),relay});
    const middleware = [...this.middleware];
    const commands = [...this.commandHandlers.values()];
    const fallback = this.fallback;
    let last = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= last) {
        throw new Error('next() called more than once');
      }
      last = i;
      if (middleware[i]) {
        await middleware[i](ctx, () => dispatch(i + 1));
      } else {
        for (const command of commands) {
          if (await command(ctx, client.pubkey)) return;
        }
        await fallback?.(ctx);
      }
    };
    try {
      await dispatch(0);
      if(!this.validatorFailures.has(ctx))await commit();
    }
    catch (e) {
      const failure=this.validatorFailures.get(ctx);
      if(failure)throw failure.error;
      if (this.errorHandler) {
        try {
          await this.errorHandler(e, ctx);
        } catch {
          // An observer failure must not replace the original retryable error.
        }
      }
      if(e instanceof InvalidArgsError&&e===this.invalidArgs.get(ctx))return; // Terminal input errors are observed once, never retried/reported as operations.
      // Business errors remain retryable even if observed by catch().
      throw e;
    }
    // Exit the reply-capable middleware/catch chain before reporting an unapproved validator exception.
    const failure=this.validatorFailures.get(ctx);
    if(failure)throw failure.error;
  }

  start() {
    this.assertActive();
    return this.client.start();
  }

  stop() {
    return this.client.stop();
  }

  /** Detach this Bot and queue catalog synchronization; in-flight handlers can finish. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detach?.();
    this.detachPublic?.();
    this.fallback = undefined;
    for (const release of this.releaseDefinitions.values()) {
      release();
    }
    this.releaseDefinitions.clear();
    this.definitions.clear();
    this.commandHandlers.clear();
  }

  async close() {
    this.dispose();
  }
}
