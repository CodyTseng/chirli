/** Loopback demo/test fixture, not a production relay. */
import { WebSocketServer, type WebSocket } from "ws";
import { matchFilter, verifyEvent, type Event, type Filter } from "nostr-tools";
export async function createLocalRelay() {
	let connectionDelayMs = 0;
	const server = new WebSocketServer({
		port: 0,
		host: "127.0.0.1",
		verifyClient: (_info, accept) => {
			if (connectionDelayMs === 0) accept(true);
			else setTimeout(() => accept(true), connectionDelayMs);
		},
	});
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const events = new Map<string, Event>(),
		subscriptions = new Map<WebSocket, Map<string, Filter>>();
	let rejectPublish = false,
		pauseReads = false,
		sendEose = true,
		connections = 0;
	server.on("connection", (ws) => {
		connections++;
		const requests = new Map<string, Filter>();
		subscriptions.set(ws, requests);
		ws.on("close", () => subscriptions.delete(ws));
		ws.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m[0] === "REQ") {
				if (pauseReads && m[2].kinds?.includes(1059)) {
					ws.send(JSON.stringify(["CLOSED", m[1], "temporarily unavailable"]));
					return;
				}
				if (!subscriptions.has(ws)) return;
				requests.set(m[1], m[2]);
				for (const e of [...events.values()]
					.filter((event) => matchFilter(m[2], event))
					.sort(
						(a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
					)
					.slice(0, m[2].limit ?? events.size))
					ws.send(JSON.stringify(["EVENT", m[1], e]));
				if (sendEose) ws.send(JSON.stringify(["EOSE", m[1]]));
			}
			if (m[0] === "EVENT") {
				const e = m[1] as Event;
				if (rejectPublish || !verifyEvent(e)) {
					ws.send(JSON.stringify(["OK", e.id, false, "rejected"]));
					return;
				}
				events.set(e.id, e);
				ws.send(JSON.stringify(["OK", e.id, true, "stored"]));
				for (const [socket, subs] of subscriptions)
					for (const [id, f] of subs)
						if (matchFilter(f, e))
							socket.send(JSON.stringify(["EVENT", id, e]));
			}
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Example relay has no TCP address");
	return {
		url: `ws://127.0.0.1:${address.port}`,
		events,
		get connections() {
			return connections;
		},
		get activeConnections() {
			return server.clients.size;
		},
		disconnect() {
			for (const ws of server.clients) ws.terminate();
		},
		delayNewConnections(ms: number) {
			connectionDelayMs = ms;
		},
		setEose(value: boolean) {
			sendEose = value;
		},
		pauseReads(value: boolean) {
			pauseReads = value;
		},
		reject(value: boolean) {
			rejectPublish = value;
		},
		async close() {
			for (const ws of server.clients) ws.terminate();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}
