import type { UploadFileResult } from './blossom.js';
import type { Event } from 'nostr-tools';
import { signChecked, type Identity } from './protocol.js';
import { commandRelayURL, parseCommandHead, matchesCommandScopes, type CommandDefinition } from './nipcd.js';
import { InboxSubscription, type ReconnectOptions } from './inbox.js';
import { relayUnion } from './relay-roles.js';
import { PublicThreads, publicEvent, threadStructure, referenceKey, commentReply, type PublicThreadOptions, type ThreadOptions } from './public-thread.js';
import type { Store } from './store.js';
import {localReadBoundary,type Transport} from './relay.js';
export interface PublicInboxOptions {
    relays: readonly string[];
    thread?: PublicThreadOptions;
}
export interface PublicInput {
    event: Event;
    relay: string;
    conversation: string;
}
interface Record {
    event?: Event;
    relay: string;
    state: 'history' | 'pending' | 'processing' | 'failed' | 'done';
}
interface State {
    version: 1;
    records: {
        [id: string]: Record;
    };
    outbox: {
        event: Event;
        relays: string[];
    }[];
}
/** Explicit public command inbox. Never shares private message rows, conversation keys or outbox. */
export class PublicInbox {
    private state: State;
    private subscriptions?: InboxSubscription;
    private running = false;
    private kinds = '';
    private initialReady=false;
    private starting?:Promise<void>;
    private generation=0;
    private queues = new Map<string, Promise<void>>();
    private scheduled = new Set<string>();
    private flushing?: Promise<void>;
    private relays: string[];
    readonly threads: PublicThreads;
    constructor(private identity: Identity, private store: Store, private transport: Transport, options: PublicInboxOptions, private writes: string[], private reconnect: false | ReconnectOptions | undefined, private definitions: () => CommandDefinition[], private allowed: (sender: string) => boolean, private process: (input: PublicInput) => Promise<void>, private report: (error: unknown) => void) {
        if (!Array.isArray(options.relays) || !options.relays.length)
            throw new TypeError('publicInbox.relays requires explicit relay URLs');
        this.relays = [...new Set(options.relays.map(commandRelayURL))];
        this.threads = new PublicThreads(transport, this.relays, options.thread);
        this.state = store.metadata<State>('public-inputs') ?? { version: 1, records: {}, outbox: [] };
        if (this.state.version !== 1 || !this.state.records || !Array.isArray(this.state.outbox))
            throw new Error('Unsupported public input journal');
        for (const record of Object.values(this.state.records))
            if (record.state === 'processing')
                record.state = 'pending';
    }
    private save() { this.store.saveMetadata('public-inputs', this.state); }
    private conversation(event: Event) { const structure = threadStructure(event); return `public:${structure.root ? referenceKey(structure.root) : `e:${event.id}`}`; }
    private accepted(event: Event, relay: string) {
        if (![1, 1111].includes(event.kind) || event.pubkey === this.identity.pubkey || !this.relays.includes(commandRelayURL(relay)) || !this.allowed(event.pubkey))
            return false;
        try {
            threadStructure(event);
        }
        catch {
            return false;
        }
        return this.definitions().some(definition => {
            const result = parseCommandHead(event.content,definition.command,this.identity.pubkey);
            if (result.status !== 'matched'||!matchesCommandScopes(definition.scopes??[],event,{relay}))
                return false;
            if (result.qualifier !== undefined)
                return true;
            const targets = new Set(event.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]));
            return targets.size === 1 && targets.has(this.identity.pubkey);
        });
    }
    start(kinds: number[]):Promise<void> {
        const next = [...new Set(kinds)].sort().join(',');
        const alreadyInitialized=this.running&&next===this.kinds&&this.initialReady;
        // initialReady gates inbox initialization only. A failed REQ still needs retry even
        // on an OPEN socket; an active REQ does not become disconnected while awaiting EOSE.
        const reusable=this.initialReady&&(this.reconnect!==false||!kinds.length||this.subscriptions?.hasUsableSubscription());
        if(this.running&&next===this.kinds&&(reusable||this.starting))return this.starting??Promise.resolve();
        this.subscriptions?.close();
        this.subscriptions=undefined;
        this.running=true;
        this.kinds=next;
        this.initialReady=false;
        const generation=++this.generation;
        if(!kinds.length){this.initialReady=true;this.starting=undefined;return Promise.resolve();}
        const current=()=>this.running&&this.generation===generation&&this.subscriptions===subscription;
        // Replay only pre-existing local unfinished work, once for this activation. New live
        // failures and replayed relay history must not become automatic recovery retries.
        const unfinished=Object.entries(this.state.records).filter(([,record])=>['pending','failed'].includes(record.state)&&record.event).map(([id])=>id);
        let initialized=alreadyInitialized;
        const initialize=async()=>{
            if(!current())return;
            this.initialReady=true;
            if(!initialized){
                initialized=true;
                for(const id of unfinished){const record=this.state.records[id];if(record&&['pending','failed'].includes(record.state)&&record.event)this.enqueue(id,record);}
            }
            await this.flush();
        };
        const subscription=new InboxSubscription({transport:this.transport,store:this.store,relays:this.relays,filter:{kinds,limit:500},recovery:false,localReadWindow:true,reconnect:this.reconnect,
            receive:async(event,source,relay)=>{this.receive(event,source,relay);},error:this.report,
            reconnected:initialize});
        this.subscriptions=subscription;
        const task=(async()=>{
            try {await subscription.ready;}
            catch(error){
                if(current()){
                    this.initialReady=false;
                    if(this.reconnect===false){this.subscriptions=undefined;this.running=false;subscription.close();}
                    // Otherwise retain managed automatic retries. A same-kind start after rejection
                    // can replace this unready owner, unless it has already recovered.
                }
                throw error;
            }
            await initialize();
        })().finally(()=>{if(this.starting===task)this.starting=undefined;});
        this.starting=task;
        return task;
    }
    receive(input: Event, source: 'live' | 'history', relay?: string): boolean {
        if (!this.running || !relay)
            return false;
        const boundary=localReadBoundary(input),event = publicEvent(input);
        if (!event || !this.accepted(event, relay))
            return false;
        if(source==='history'&&boundary!==undefined&&event.created_at>boundary)source='live';
        if (Object.hasOwn(this.state.records, event.id))
            return false;
        let evicted: [
            string,
            Record
        ] | undefined;
        if (Object.keys(this.state.records).length >= 5000) {
            const old = Object.keys(this.state.records).find(id => ['history', 'done'].includes(this.state.records[id].state));
            if (!old)
                throw new Error('Public pending journal capacity exceeded');
            evicted = [old, this.state.records[old]];
            delete this.state.records[old];
        }
        const record: Record = { ...(source === 'live' ? { event } : {}), relay, state: source === 'history' ? 'history' : 'pending' };
        this.state.records[event.id] = record;
        try {
            this.save();
        }
        catch (error) {
            delete this.state.records[event.id];
            if (evicted)
                this.state.records[evicted[0]] = evicted[1];
            throw error;
        }
        if (source === 'live')
            this.enqueue(event.id, record);
        return true;
    }
    private enqueue(id: string, record: Record) {
        if (this.scheduled.has(id) || !record.event)
            return;
        const event = publicEvent(record.event);
        if (!event || !this.accepted(event, record.relay)) {
            record.state = 'done';
            delete record.event;
            this.save();
            return;
        }
        const conversation = this.conversation(event);
        this.scheduled.add(id);
        const task = (this.queues.get(conversation) ?? Promise.resolve()).catch(() => { }).then(async () => {
            if (!this.accepted(event, record.relay)) {
                record.state = 'done';
                delete record.event;
                this.save();
                return;
            }
            const previous = record.state;
            record.state = 'processing';
            try {
                this.save();
            }
            catch (error) {
                record.state = previous;
                throw error;
            }
            try {
                await this.process({ event: structuredClone(event), relay: record.relay, conversation });
                record.state = 'done';
                delete record.event;
            }
            catch (error) {
                record.state = 'failed';
                this.report(error);
            }
            try {
                this.save();
            }
            catch (error) {
                record.state = 'failed';
                record.event = event;
                throw error;
            }
        }).catch(error => this.report(error)).finally(() => {
            this.scheduled.delete(id);
            if (this.queues.get(conversation) === task)
                this.queues.delete(conversation);
        });
        this.queues.set(conversation, task);
    }
    /** Signed public input is sufficient; provenance comes only from our own journal. */
    target(input: Event): PublicInput {
        const event=publicEvent(input);
        if(!event || ![1,1111].includes(event.kind))throw new TypeError('Expected a valid signed kind 1/1111 event');
        threadStructure(event);
        const known=this.state.records[event.id]?.relay;
        const relay=known&&this.relays.includes(commandRelayURL(known))?known:'';
        return {event,relay,conversation:this.conversation(event)};
    }
    async reply(input: PublicInput, text: string) {
        if (typeof text !== 'string' || !text.length)
            throw new TypeError('Nonempty reply text required');
        const root = await this.threads.rootForReply(input.event);
        return this.publishReply(input, commentReply(input.event, root, text, input.relay));
    }
    async replyFile(input: PublicInput, upload: () => Promise<UploadFileResult>) {
        const root = await this.threads.rootForReply(input.event);
        // Validate the reply structure before exposing any bytes to an upload endpoint.
        const template = commentReply(input.event, root, 'attachment', input.relay);
        const { url, mimeType, sha256, size } = await upload();
        template.content = url;
        template.created_at = Math.floor(Date.now() / 1000);
        template.tags.push(['imeta', `url ${url}`, `m ${mimeType}`, `x ${sha256}`, `size ${size}`]);
        return this.publishReply(input, template);
    }
    private async publishReply(input: PublicInput, template: ReturnType<typeof commentReply>) {
        const event = await signChecked(this.identity, template);
        const relays = relayUnion(this.writes, input.relay && this.relays.includes(commandRelayURL(input.relay)) ? [input.relay] : []);
        this.state.outbox.push({ event, relays });
        try {
            this.save();
        }
        catch (error) {
            this.state.outbox.pop();
            throw error;
        }
        try {
            await this.flush();
        }
        catch (error) {
            this.report(error);
        }
        return { id: event.id, status: this.state.outbox.some(item => item.event.id === event.id) ? 'pending' as const : 'relay-accepted' as const };
    }
    flush(): Promise<void> {
        if (this.flushing)
            return this.flushing.then(() => this.flush());
        const task = (async () => {
            while (this.state.outbox.length) {
                const item = this.state.outbox[0];
                await this.transport.publish(item.relays, item.event);
                this.state.outbox.shift();
                try {
                    this.save();
                }
                catch (error) {
                    this.state.outbox.unshift(item);
                    throw error;
                }
            }
        })().finally(() => {
            if (this.flushing === task)
                this.flushing = undefined;
        });
        this.flushing = task;
        return task;
    }
    retry(ids?: Set<string>) {
        if (!this.running)
            return;
        for (const [id, record] of Object.entries(this.state.records))
            if ((!ids || ids.has(id)) && ['pending', 'failed'].includes(record.state))
                this.enqueue(id, record);
    }
    thread(input: PublicInput, options?: ThreadOptions) { return this.threads.resolve(input.event, options); }
    stop() { this.running=false;this.generation++;this.initialReady=false;this.starting=undefined;this.subscriptions?.close();this.subscriptions=undefined; }
    async idle() {
        while (this.queues.size)
            await Promise.all(this.queues.values());
        await this.flushing?.catch(() => { });
    }
}
