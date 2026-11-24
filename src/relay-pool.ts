import WebSocket from "ws";
import {
	AbstractRelay,
	type Subscription as NostrSubscription,
} from "nostr-tools/abstract-relay";
import {
	verifyEvent,
	type Event,
	type EventTemplate,
	type Filter,
} from "nostr-tools";
import { RelayError } from "./errors.js";

export interface RelayTimeouts {
	connectionTimeoutMs: number;
	eoseTimeoutMs: number;
	publishTimeoutMs: number;
	authTimeoutMs: number;
	idleTimeoutMs: number;
	heartbeatIntervalMs: number;
	heartbeatTimeoutMs: number;
}

export const DEFAULT_RELAY_TIMEOUTS: Readonly<RelayTimeouts> = Object.freeze({
	connectionTimeoutMs: 5000,
	eoseTimeoutMs: 25000,
	publishTimeoutMs: 5000,
	authTimeoutMs: 8000,
	idleTimeoutMs: 30000,
	heartbeatIntervalMs: 30000,
	heartbeatTimeoutMs: 10000,
});

interface Consumer {
	failed(error: RelayError): void;
	authenticating(): void;
	authenticated(): void;
	wireEose(id: string): void;
	rawEvent(id: string): void;
}

interface Connection {
	url: string;
	relay: LibraryRelay;
	ready: Promise<void>;
	users: Set<Consumer>;
	publications: Map<
		string,
		{
			body: string;
			pending: Promise<string>;
			replayGeneration: number;
			replays: number;
		}
	>;
	acks: Map<string, boolean>;
	ackIds: Set<string>;
	idle?: ReturnType<typeof setTimeout>;
	authTimer?: ReturnType<typeof setTimeout>;
	challenge?: string;
	authGeneration: number;
	failed: boolean;
	fail(error: RelayError): void;
}

export interface RelayLease {
	readonly authenticating: boolean;
	ready: Promise<void>;
	subscribe(
		filter: Filter,
		params: Parameters<AbstractRelay["subscribe"]>[1],
	): NostrSubscription;
	publish(event: Event, afterAuth?: boolean): Promise<string>;
	release(): void;
}

/** Public send override, as in the reference apps: no deferred orphan REQ/AUTH writes. */
class LibraryRelay extends AbstractRelay {
	private authWrite = false;
	constructor(
		url: string,
		socket: typeof globalThis.WebSocket,
		private currentSocket: () => WebSocket | undefined,
	) {
		super(new URL(url).origin, {
			websocketImplementation: socket,
			verifyEvent: (event) => {
				try {
					return verifyEvent(event);
				} catch {
					return false;
				}
			},
			enableReconnect: false,
			enablePing: true,
		});
		this.onnotice = () => {}; // Relay notices can contain private input or credential-bearing URLs.
	}
	override send(message: string): Promise<void> {
		const socket = this.currentSocket();
		const failed = () => {
			if (!message.startsWith('["CLOSE",')) queueMicrotask(() => this.close());
			// Subscription.fire/close do not await send. Retire failed demand through
			// onclose instead of producing an orphan rejected promise.
			return message.startsWith('["REQ",') || message.startsWith('["CLOSE",')
				? Promise.resolve()
				: Promise.reject(new Error("Relay write failed"));
		};
		if (!this.connected || socket?.readyState !== WebSocket.OPEN)
			return failed();
		try {
			// AbstractRelay.auth caches one promise for the entire connection, even after a
			// different challenge. Use its publish ACK machinery for challenge-scoped AUTH.
			// The signed template is constructed by this adapter; ordinary events stay EVENT.
			socket.send(
				this.authWrite && message.startsWith('["EVENT",')
					? `["AUTH",${message.slice(9)}`
					: message,
			);
			return Promise.resolve();
		} catch {
			return failed();
		}
	}

	publishAuth(event: Event): Promise<string> {
		this.authWrite = true;
		try {
			return super.publish(event);
		} finally {
			this.authWrite = false;
		}
	}
}

/** One nostr-tools physical relay per exact URL. Durable retries belong to InboxSubscription. */
export class RelayPool {
	private connections = new Map<string, Connection>();
	private closed = false;

	constructor(
		private timeouts: RelayTimeouts,
		private sign?: (template: EventTemplate) => Promise<Event>,
		private createSocket = (url: string) =>
			new WebSocket(url, { maxPayload: 1024 * 1024 }),
	) {}

	isConnected(url: string): boolean {
		try {
			return (
				!this.closed &&
				this.connections.get(new URL(url).href)?.relay.connected === true
			);
		} catch {
			return false;
		}
	}

	acquire(url: string, consumer: Consumer): RelayLease {
		if (this.closed) throw this.error(url, "RELAY_CLOSED");
		const key = new URL(url).href;
		let connection = this.connections.get(key);
		if (!connection) {
			connection = this.connect(key);
			this.connections.set(key, connection);
		}
		const current = connection;
		clearTimeout(current.idle);
		current.users.add(consumer);
		let released = false;
		return {
			get authenticating() {
				return current.authTimer !== undefined;
			},
			ready: current.ready,
			subscribe: (filter, params) => current.relay.subscribe([filter], params),
			publish: (event, afterAuth = false) => {
				const body = JSON.stringify(event),
					prior = current.publications.get(event.id);
				if (prior) {
					if (prior.body !== body)
						return Promise.reject(this.error(key, "RELAY_EVENT_REJECTED"));
					if (afterAuth && prior.replayGeneration !== current.authGeneration) {
						if (prior.replays >= 1)
							return Promise.reject(
								new Error("auth-required: retry exhausted"),
							);
						prior.replays++;
						prior.replayGeneration = current.authGeneration;
						// Keep the existing library ACK slot when a challenge arrived without
						// rejecting the first EVENT. Do not call publish() over the same slot.
						void current.relay
							.send(`["EVENT",${body}]`)
							.catch(() => current.fail(this.error(key, "RELAY_CLOSED")));
					}
					return prior.pending;
				}
				if (current.ackIds.has(event.id))
					return Promise.reject(this.error(key, "RELAY_EVENT_REJECTED"));
				current.relay.publishTimeout = this.timeouts.publishTimeoutMs;
				current.acks.delete(event.id);
				current.ackIds.add(event.id);
				const pending = current.relay.publish(event).then((reason) => {
					if (current.acks.get(event.id) !== true)
						throw new Error("Invalid relay ACK");
					return reason;
				});
				const entry = {
					body,
					pending,
					replayGeneration: afterAuth ? current.authGeneration : -1,
					replays: afterAuth ? 1 : 0,
				};
				current.publications.set(event.id, entry);
				void pending
					.finally(() => {
						if (current.publications.get(event.id) === entry) {
							current.publications.delete(event.id);
							current.acks.delete(event.id);
							current.ackIds.delete(event.id);
						}
					})
					.catch(() => {});
				return pending;
			},
			release: () => {
				if (released) return;
				released = true;
				current.users.delete(consumer);
				if (current.users.size || current.failed) return;
				if (!current.relay.connected) {
					current.fail(this.error(key, "RELAY_CLOSED"));
					return;
				}
				current.idle = setTimeout(
					() => current.fail(this.error(key, "RELAY_CLOSED")),
					this.timeouts.idleTimeoutMs,
				);
				current.idle.unref();
			},
		};
	}

	private error(
		url: string,
		code: ConstructorParameters<typeof RelayError>[1]["code"],
		extras: Partial<ConstructorParameters<typeof RelayError>[1]> = {},
	) {
		return new RelayError("Relay operation failed", {
			relay: url,
			operation: code.startsWith("RELAY_AUTH") ? "auth" : "connect",
			code,
			...extras,
		});
	}

	private connect(url: string): Connection {
		let socket: WebSocket | undefined;
		let opened = false;
		let connection!: Connection;
		let networkError: RelayError | undefined;
		const factory = this.createSocket;
		// Public injection preserves exact handshake routing despite AbstractRelay URL normalization.
		const Socket = class {
			static OPEN = WebSocket.OPEN;
			static CLOSING = WebSocket.CLOSING;
			static CLOSED = WebSocket.CLOSED;
			constructor() {
				socket = factory(url);
				socket.on("open", () => {
					opened = true;
				});
				socket.on("error", (error) => {
					networkError = new RelayError("Relay connection failed", {
						relay: url,
						operation: "connect",
						code: "RELAY_CONNECTION_FAILED",
						networkCode: (error as NodeJS.ErrnoException).code,
					});
				});
				socket.on("unexpected-response", (_request, response) => {
					response.resume();
					networkError = new RelayError("Relay HTTP handshake rejected", {
						relay: url,
						operation: "connect",
						code: "RELAY_HTTP_REJECTED",
						statusCode: response.statusCode,
					});
					connection.fail(networkError);
				});
				socket.on("close", (closeCode) => {
					networkError ??= new RelayError("Relay disconnected", {
						relay: url,
						operation: "subscribe",
						code: "RELAY_CLOSED",
						closeCode,
					});
				});
				// Observe only small control frames. EVENT parsing, filtering and signature
				// verification are owned by nostr-tools, not a second frame dispatcher.
				socket.on("message", (raw) => {
					const text = raw.toString();
					const eventHeader =
						/^\s*\[\s*"EVENT"\s*,\s*("(?:\\.|[^"\\])*")\s*,/.exec(text);
					if (eventHeader) {
						try {
							const id: unknown = JSON.parse(eventHeader[1]);
							if (typeof id === "string")
								for (const user of [...connection.users]) user.rawEvent(id);
						} catch {}
						return;
					}
					if (!/^\s*\[\s*"(?:EOSE|AUTH|OK)"/.test(text)) return;
					try {
						const frame: unknown = JSON.parse(text);
						if (
							!Array.isArray(frame) ||
							typeof frame[1] !== "string" ||
							connection.failed
						)
							return;
						if (frame[0] === "EOSE" && !connection.authTimer) {
							for (const user of [...connection.users]) user.wireEose(frame[1]);
						}
						if (frame[0] === "AUTH") thisAuth(frame[1]);
						if (frame[0] === "OK" && connection.ackIds.has(frame[1]))
							connection.acks.set(frame[1], frame[2] === true);
					} catch {
						/* Untrusted control frames are ignored without diagnostics. */
					}
				});
				// biome-ignore lint/correctness/noConstructorReturn: nostr-tools constructs the supplied WebSocket and needs the factory socket.
				return socket;
			}
		} as unknown as typeof globalThis.WebSocket;
		const relay = new LibraryRelay(url, Socket, () => socket);
		relay.pingFrequency = this.timeouts.heartbeatIntervalMs;
		relay.pingTimeout = this.timeouts.heartbeatTimeoutMs;
		relay.publishTimeout = this.timeouts.publishTimeoutMs;
		relay.baseEoseTimeout = this.timeouts.eoseTimeoutMs;
		const abort = new AbortController();
		connection = {
			url,
			relay,
			ready: Promise.resolve(),
			users: new Set(),
			publications: new Map(),
			acks: new Map(),
			ackIds: new Set(),
			authGeneration: 0,
			failed: false,
			fail: () => {},
		};
		connection.fail = (error) => {
			if (connection.failed) return;
			connection.failed = true;
			clearTimeout(connection.idle);
			clearTimeout(connection.authTimer);
			if (this.connections.get(url) === connection)
				this.connections.delete(url);
			abort.abort();
			// Notify first, so owned subscriptions clear the library's EOSE timer before close.
			for (const user of [...connection.users]) {
				try {
					user.failed(error);
				} catch {}
			}
			connection.users.clear();
			relay.close();
		};
		relay.onclose = () => {
			if (opened || connection.failed)
				connection.fail(networkError ?? this.error(url, "RELAY_CLOSED"));
		};
		const thisAuth = (challenge: string) => {
			const sign = this.sign;
			if (!sign || !connection.users.size || connection.challenge === challenge)
				return;
			connection.challenge = challenge;
			const generation = ++connection.authGeneration;
			connection.authTimer ??= setTimeout(
				() => connection.fail(this.error(url, "RELAY_AUTH_TIMEOUT")),
				this.timeouts.authTimeoutMs,
			);
			for (const user of [...connection.users]) user.authenticating();
			void Promise.resolve()
				.then(() =>
					sign.call(this, {
						kind: 22242,
						created_at: Math.floor(Date.now() / 1000),
						tags: [
							["relay", url],
							["challenge", challenge],
						],
						content: "",
					}),
				)
				.then(async (event) => {
					if (connection.failed || generation !== connection.authGeneration)
						return;
					// Enforce the signer boundary before inserting anything in the library ACK map.
					if (
						!verifyEvent(event) ||
						event.kind !== 22242 ||
						event.content !== "" ||
						!event.tags.some((tag) => tag[0] === "relay" && tag[1] === url) ||
						!event.tags.some(
							(tag) => tag[0] === "challenge" && tag[1] === challenge,
						)
					)
						throw new Error("Invalid auth signature");
					relay.publishTimeout = this.timeouts.authTimeoutMs;
					if (connection.ackIds.has(event.id))
						throw new Error("Conflicting auth operation");
					connection.acks.delete(event.id);
					connection.ackIds.add(event.id);
					try {
						await relay.publishAuth(event);
						if (connection.acks.get(event.id) !== true)
							throw new Error("Invalid auth ACK");
					} catch (error) {
						if (!connection.failed && generation === connection.authGeneration)
							connection.fail(
								this.error(url, "RELAY_AUTH_REJECTED", {
									reason: error instanceof Error ? error.message : undefined,
								}),
							);
						return;
					} finally {
						connection.acks.delete(event.id);
						connection.ackIds.delete(event.id);
					}
					if (connection.failed || generation !== connection.authGeneration)
						return;
					clearTimeout(connection.authTimer);
					connection.authTimer = undefined;
					for (const user of [...connection.users]) user.authenticated();
				})
				.catch(() => {
					if (!connection.failed && generation === connection.authGeneration)
						connection.fail(this.error(url, "RELAY_AUTH_SIGNING_FAILED"));
				});
		};
		const connecting = relay.connect({
			timeout: this.timeouts.connectionTimeoutMs,
			abort: abort.signal,
		});
		const connectedSocket = socket;
		const receive = connectedSocket?.onmessage;
		if (connectedSocket && receive)
			connectedSocket.onmessage = (message) => {
				if (connection.failed) return;
				const text = String(message.data);
				// A native JSON syntax preflight is necessary because the dependency logs
				// raw input and URLs on parser failure. It does not route or decode Nostr.
				let frame: unknown;
				try {
					frame = JSON.parse(text);
				} catch {
					return;
				}
				if (!Array.isArray(frame) || typeof frame[1] !== "string") return;
				if (frame[0] === "EVENT") {
					// All SDK physical subscription IDs are UUIDs. Canonical framing keeps
					// the library's fast header scanner safe with unusual whitespace/escapes.
					if (
						!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(frame[1]) ||
						frame.length !== 3
					)
						return;
					receive.call(connectedSocket, {
						data: JSON.stringify(frame),
					} as WebSocket.MessageEvent);
					return;
				}
				if (!["EOSE", "AUTH", "OK", "CLOSED", "NOTICE"].includes(frame[0]))
					return;
				if (frame[0] === "CLOSED" && typeof frame[2] !== "string") {
					receive.call(connectedSocket, {
						data: JSON.stringify([
							"CLOSED",
							frame[1],
							"error: malformed relay response",
						]),
					} as WebSocket.MessageEvent);
					return;
				}
				receive.call(connectedSocket, message);
			};
		connection.ready = connecting.catch((error) => {
			const reason =
				error === "connection timed out"
					? this.error(url, "RELAY_CONNECT_TIMEOUT")
					: (networkError ??
						this.error(
							url,
							connection.failed ? "RELAY_CLOSED" : "RELAY_CONNECTION_FAILED",
						));
			connection.fail(reason);
			throw reason;
		});
		void connection.ready.catch(() => {});
		return connection;
	}

	close() {
		this.closed = true;
		for (const connection of [...this.connections.values()])
			connection.fail(this.error(connection.url, "RELAY_CLOSED"));
	}
}
