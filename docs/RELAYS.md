# DM, read and write relays

Set each relay role independently. The common `relays` option supplies any role you leave unspecified.

```ts
const bot = new Bot({
  signer,
  dmRelays: ['wss://inbox.example'],
  readRelays: ['wss://read.example'],
  writeRelays: ['wss://write.example'],
});
await bot.start();
```

| Role | Purpose | Default hosts |
| --- | --- | --- |
| `dmRelays` | Subscribe to the inbox, recover history and provide delivery fallback | relay.psstpsst.chat, nos.lol, relay.ditto.pub |
| `readRelays` | Add relays for metadata discovery | nos.lol, relay.primal.net, relay.ditto.pub, offchain.pub |
| `writeRelays` | Publish commands and account metadata | Same as `readRelays` |

Defaults are exported as `DEFAULT_DM_RELAYS`, `DEFAULT_READ_RELAYS` and `DEFAULT_WRITE_RELAYS`. The DM and write lists must be nonempty. Pass `readRelays: []` to omit that role. Discovery still queries the union of configured read, write and DM relays. The live examples map these roles to [environment variables](../examples/live/README.md).

## Account announcements

Startup signs and publishes account metadata before opening the inbox.

| Kind | Published data | Targets |
| --- | --- | --- |
| `10044` | Messaging key | Write and DM relays |
| `10002` | Read and write relay roles | Write and DM relays |
| `10050` | Inbox relay URLs | Write and DM relays |
| `31992`, `5` | Command definitions and withdrawals | Write relays |

Account metadata needs one positive ACK in each distinct write or DM set. Command synchronization requires successful queries and publication on every configured write relay. See [command synchronization](NIP-CD.md) and [messaging key configuration](KEYS.md).

## Readiness and delivery

- **Inbox startup.** One DM relay must reach EOSE and finish its initial recovery attempt. Other replicas can continue reconnecting. If all initial attempts fail, startup rejects. See [recovery](RECOVERY.md).
- **Discovery.** Metadata queries combine successful relay snapshots. If every query fails, discovery reports an error. Results reflect only what those relays returned.
- **Delivery.** Each encrypted peer or self copy needs one positive ACK. Relay acceptance indicates that a relay accepted the event. A wholly unsuccessful bundle stays in the outbox. `flushOutbox()`, startup and reconnect reuse the original ciphertext, IDs and targets.

Peer delivery uses verified inbox metadata. The Bot falls back to its own DM relays when it has no usable peer inbox list. Self copies use the Bot's advertised inbox or its configured DM relays.

## Transport and diagnostics

The default WebSocket transport pools normalized relay URLs and shares NIP-42 authentication per connection. Specify overrides through `transportOptions`.

| Deadline | Default |
| --- | --- |
| `connectionTimeoutMs` | 5 seconds |
| `eoseTimeoutMs` | 25 seconds |
| `publishTimeoutMs` | 5 seconds |
| `authTimeoutMs` | 8 seconds |
| `idleTimeoutMs` | 30 seconds |
| `heartbeatIntervalMs` / `heartbeatTimeoutMs` | Ping every 30 seconds, allow 10 seconds for pong |

An injected transport is application-owned. Its raw subscriptions report readiness and failures. The Bot manages reconnect and per-relay recovery above the transport.

`RelayError` includes an operation, error code and sanitized relay origin. Optional fields include a network code, HTTP status, WebSocket close code and event kind. An `AggregateError` can contain failures from multiple relays. The live runner formats these diagnostics and supports timing output. See [diagnosing slow replies](../examples/live/README.md#diagnose-slow-replies).

## Own metadata and peer cache

The Bot subscribes to its own verified `10044` and `10050` events. This view informs routing and key checks. Changing an advertised inbox does not reconfigure the Bot's actual subscriptions. Recreate the Bot with the new `dmRelays` to change them.

Peer metadata stays in memory. It can be refreshed in the background, and a newer authenticated seal can supersede cached key evidence.

| `metadataCache` setting | Default |
| --- | --- |
| `ttlMs` | 10 minutes for usable data |
| `negativeTtlMs` | 30 seconds for confirmed absence |
| `maxStaleMs` | 24 hours for previously usable data |
| `maxEntries` | 512 peers |

Call `await bot.refreshPeer(peerPubkey)` to force discovery, or set `metadataCache: false` to disable peer cache reads. Already queued outbox bundles retain their original encryption and targets.

After building, run `npm run example:local` for a two-relay loopback demo.

Command startup synchronization reads the broad own-author 31992 snapshot once per write relay (bounded paging if needed), not one query per command and not remote withdrawal history. Local pending kind 5 requests retry unchanged even when relays already removed their targets. Confirmed local definitions absent from fresh snapshots do not trigger repeated withdrawals. Independent command discovery uses author-scoped 31992/5 snapshots to verify deletions across replicas. Silent relay caps/omissions cannot be detected universally.

## Explicit public command inbox

Public kind 1/1111 subscriptions require `publicInbox:{relays:[...]}` independently of DM roles and never inherit a default public firehose. Only currently declared public kinds are subscribed. Replicas reconnect through the shared managed subscription layer; pre-EOSE history is not executed. Replies route to configured write relays and the configured source relay, not arbitrary relay hints. Public thread lookups use the explicit inbox relay set and bounded query budgets. See [public input](PUBLIC.md).
