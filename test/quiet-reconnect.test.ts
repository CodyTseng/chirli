import { test } from "node:test";
import assert from "node:assert/strict";
import { InboxSubscription, type ReconnectOptions } from "../src/inbox.js";
import { Store } from "../src/store.js";
import { RelayError } from "../src/errors.js";
import type { Transport } from "../src/relay.js";
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(reconnect: false | ReconnectOptions | undefined = undefined) {
  const errors: unknown[] = [],
    store = new Store(":memory:", undefined, "quiet-test");
  let disconnect: ((error: Error) => void) | undefined,
    offline = false,
    connections = 0;
  const closed = () =>
    new RelayError("Relay connection closed", {
      relay: "ws://local.invalid",
      operation: "subscribe",
      code: "RELAY_CLOSED",
    });
  const transport: Transport = {
    subscribe: (_relays, _filter, _receive, onDisconnect) => {
      connections++;
      disconnect = onDisconnect;
      return {
        ready: offline ? Promise.reject(closed()) : Promise.resolve(),
        close() {},
      };
    },
    query: async () => [],
    publish: async () => {},
    close() {},
  };
  const subscription = new InboxSubscription({
    transport,
    store,
    relays: ["ws://local.invalid"],
    filter: { kinds: [1059] },
    reconnect,
    recovery: false,
    receive() {},
    error: (error) => errors.push(error),
    reconnected: async () => {},
  });
  return {
    subscription,
    errors,
    store,
    get connections() {
      return connections;
    },
    drop() {
      assert.ok(disconnect);
      disconnect(closed());
    },
    reject() {
      assert.ok(disconnect);
      disconnect(
        new RelayError("Subscription rejected", {
          relay: "ws://local.invalid",
          operation: "subscribe",
          code: "RELAY_AUTH_REJECTED",
        }),
      );
    },
    set offline(value: boolean) {
      offline = value;
    },
    close() {
      subscription.close();
      store.close();
    },
  };
}
test("a brief established disconnect reconnects without error reporting", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.subscription.ready;
    f.drop();
    assert.equal(f.errors.length, 0);
    ctx.mock.timers.tick(2000);
    await settle();
    assert.equal(f.connections, 2);
    ctx.mock.timers.tick(60_000);
    await settle();
    assert.equal(f.errors.length, 0);
  } finally {
    f.close();
  }
});
test("persistent established network outage reports once after the grace period", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.subscription.ready;
    f.offline = true;
    f.drop();
    ctx.mock.timers.tick(29_999);
    await settle();
    assert.equal(f.errors.length, 0);
    ctx.mock.timers.tick(1);
    await settle();
    assert.equal(f.errors.length, 1);
    ctx.mock.timers.tick(60_000);
    await settle();
    assert.equal(f.errors.length, 1);
    f.offline = false;
    ctx.mock.timers.tick(60_000);
    await settle();
    f.drop();
    ctx.mock.timers.tick(2000);
    await settle();
    assert.equal(f.errors.length, 1, "recovery resets the quiet grace period");
  } finally {
    f.close();
  }
});
test("stop cancels delayed warnings and reconnect demand", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  try {
    await f.subscription.ready;
    f.drop();
    f.subscription.close();
    ctx.mock.timers.tick(60_000);
    await settle();
    assert.equal(f.errors.length, 0);
    assert.equal(f.connections, 1);
  } finally {
    f.close();
  }
});
test("disabled reconnect and explicit authentication rejection still report immediately", async () => {
  for (const reconnect of [false, undefined] as const) {
    const f = fixture(reconnect);
    try {
      await f.subscription.ready;
      if (reconnect === false) f.drop();
      else f.reject();
      assert.equal(f.errors.length, 1);
    } finally {
      f.close();
    }
  }
});

test("default retries follow the PsstPsst steps and short successful connections do not reset backoff", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ jitter: 0 });
  try {
    await f.subscription.ready;
    f.drop();
    ctx.mock.timers.tick(999);
    await settle();
    assert.equal(f.connections, 1);
    ctx.mock.timers.tick(1);
    await settle();
    assert.equal(f.connections, 2);
    f.offline = true;
    f.drop();
    for (const delay of [2000, 5000, 10000, 20000, 30000, 60000, 60000]) {
      const previous: number = f.connections;
      ctx.mock.timers.tick(delay - 1);
      await settle();
      assert.equal(f.connections, previous);
      ctx.mock.timers.tick(1);
      await settle();
      assert.equal(f.connections, previous + 1);
    }
    f.offline = false;
    ctx.mock.timers.tick(60000);
    await settle();
    ctx.mock.timers.tick(30000);
    await settle();
    f.drop();
    const previous: number = f.connections;
    ctx.mock.timers.tick(1000);
    await settle();
    assert.equal(
      f.connections,
      previous + 1,
      "stable connection resets backoff",
    );
  } finally {
    f.close();
  }
});
test("explicit initial delay retains exponential backoff and custom stable reset", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({
    initialDelayMs: 10,
    maxDelayMs: 100,
    jitter: 0,
    stableResetMs: 50,
  });
  try {
    await f.subscription.ready;
    f.drop();
    ctx.mock.timers.tick(10);
    await settle();
    f.drop();
    const previous: number = f.connections;
    ctx.mock.timers.tick(19);
    await settle();
    assert.equal(f.connections, previous);
    ctx.mock.timers.tick(1);
    await settle();
    assert.equal(f.connections, previous + 1);
    ctx.mock.timers.tick(50);
    await settle();
    f.drop();
    ctx.mock.timers.tick(10);
    await settle();
    assert.equal(f.connections, previous + 2);
  } finally {
    f.close();
  }
});
