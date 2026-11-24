import { localNip17Identity } from "../src/protocol.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayError, WebSocketTransport } from "../src/index.js";
import { RelayError as PublicRelayError } from "chirli";
import { diagnosticLines } from "../examples/live/diagnostics.js";
const privateText = "nsec1-PRIVATE-DM-TEXT-MUST-NOT-APPEAR";
function frameEventId(value: unknown): string {
  assert.ok(value !== null && typeof value === "object" && "id" in value);
  assert.ok(typeof value.id === "string");
  return value.id;
}

async function relay(
  receive: (socket: WebSocket, frame: readonly unknown[]) => void,
) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const parsed: unknown = JSON.parse(String(raw));
      assert.ok(Array.isArray(parsed));
      receive(socket, parsed);
    }),
  );
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      for (const s of server.clients) s.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("relay rejection reports endpoint/kind/category without query credentials or raw relay text", async () => {
  const server = await relay((socket, frame) => {
      if (frame[0] === "EVENT")
        socket.send(
          JSON.stringify([
            "OK",
            frameEventId(frame[1]),
            false,
            `blocked: ${privateText}`,
          ]),
        );
    }),
    wire = new WebSocketTransport(1000),
    identity = localNip17Identity();
  try {
    const event = await identity.sign({
      kind: 10050,
      created_at: 10,
      tags: [],
      content: "",
    });
    await assert.rejects(
      wire.publish([`${server.url}/private-path?token=${privateText}`], event),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        const detail = error.errors[0];
        assert.ok(detail instanceof RelayError);
        assert.equal(detail.relay, server.url);
        assert.equal(detail.code, "RELAY_EVENT_REJECTED");
        assert.equal(detail.eventKind, 10050);
        assert.equal(detail.reason, "blocked");
        assert.ok(!JSON.stringify(detail).includes(privateText));
        assert.ok(!detail.message.includes("/private-path"));
        return true;
      },
    );
  } finally {
    wire.close();
    await server.close();
  }
});

test("EOSE and pre-handshake timeouts are distinguished and identify the relay", async () => {
  const noEOSE = await relay(() => {}),
    wire = new WebSocketTransport(200),
    sockets = new Set<Socket>(),
    http = createServer();
  http.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  http.on("upgrade", () => {});
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const hanging = `ws://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    await assert.rejects(
      wire.query([noEOSE.url], { kinds: [10050] }),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "RELAY_EOSE_TIMEOUT" &&
        error.relay === noEOSE.url,
    );
    await assert.rejects(
      wire.query([hanging], { kinds: [10050] }),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "RELAY_CONNECT_TIMEOUT" &&
        error.relay === hanging,
    );
  } finally {
    wire.close();
    await noEOSE.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("HTTP handshake and AUTH rejections retain safe status without response/challenge content", async () => {
  const http = createServer((_request, response) => {
    response.writeHead(403);
    response.end(privateText);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(http.address() as { port: number }).port}`,
    wire = new WebSocketTransport(1000),
    identity = localNip17Identity();
  const auth = await relay((socket, frame) => {
      if (frame[0] === "REQ")
        socket.send(JSON.stringify(["AUTH", privateText]));
      if (frame[0] === "AUTH")
        socket.send(
          JSON.stringify([
            "OK",
            frameEventId(frame[1]),
            false,
            `restricted: ${privateText}`,
          ]),
        );
    }),
    signed = new WebSocketTransport(1000, (t) => identity.sign(t));
  try {
    await assert.rejects(
      wire.query([url], { kinds: [10050] }),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "RELAY_HTTP_REJECTED" &&
        error.statusCode === 403 &&
        !JSON.stringify(error).includes(privateText),
    );
    await assert.rejects(
      signed.query([auth.url], { kinds: [1059] }),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "RELAY_AUTH_REJECTED" &&
        error.reason === "restricted" &&
        !JSON.stringify(error).includes(privateText),
    );
  } finally {
    wire.close();
    signed.close();
    await auth.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("formatter separates warnings/startup/handler failures, handles aggregate cycles and withholds arbitrary text", () => {
  const detail = new PublicRelayError(
    "untrusted message is not used by formatter",
    {
      relay: `wss://user:password@relay.invalid/private?token=${privateText}`,
      operation: "subscribe",
      code: "RELAY_EOSE_TIMEOUT",
      reason: `blocked: ${privateText}`,
      networkCode: privateText,
    },
  );
  const warning = diagnosticLines(detail, "background", "warning").join("\n");
  assert.match(warning, /\[warning\]\[background\]/);
  assert.match(warning, /relay=wss:\/\/relay.invalid/);
  assert.match(warning, /RELAY_EOSE_TIMEOUT/);
  for (const text of [
    privateText,
    "password",
    "/private",
    "token=",
    "untrusted message",
  ])
    assert.ok(!warning.includes(text));
  const aggregate = new AggregateError(
    [detail, new Error(privateText)],
    privateText,
  );
  const startup = diagnosticLines(aggregate, "announce").join("\n");
  assert.match(startup, /\[error\]\[announce\]/);
  assert.ok(!startup.includes(privateText));
  assert.ok(!startup.includes("Pending work is retained"));
  const handler = diagnosticLines(new Error(privateText), "handler").join("\n");
  assert.match(handler, /Application handler failed/);
  assert.ok(!handler.includes(privateText));
  const native = Object.assign(new Error(privateText), { code: "EACCES" });
  assert.match(diagnosticLines(native, "storage").join("\n"), /EACCES/);
  const cycle = new AggregateError([], privateText);
  cycle.errors.push(cycle);
  assert.ok(diagnosticLines(cycle, "announce").length < 20);
});
