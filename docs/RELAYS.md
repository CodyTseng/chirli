# Relay roles

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
| `discoveryRelays` | Extra publication targets for public account lists | Same as `readRelays` and `writeRelays` |

Defaults are exported as `DEFAULT_DM_RELAYS`, `DEFAULT_READ_RELAYS`, `DEFAULT_WRITE_RELAYS` and `DEFAULT_DISCOVERY_RELAYS`. The DM and write lists must be nonempty. Pass `readRelays: []` or `discoveryRelays: []` to omit the respective role. Peer metadata lookup still queries the union of configured read, write and DM relays. The live examples map these roles to [environment variables](../examples/live/README.md).

## Account announcements

Startup signs and publishes account metadata before opening the inbox.

| Kind | Published data | Targets |
| --- | --- | --- |
| `10044` | Messaging key | Write and DM relays |
| `10002` | Read and write relay roles | Write + discovery relays |
| `10050` | Inbox relay URLs | Write + discovery relays, plus DM relays |
| `10063` | Ordered Blossom server list | Write + discovery relays |
| `31992`, `5` | Command definitions and withdrawals | Write relays |

Each public list requires one positive ACK from the configured write relays. The inbox list also requires a DM ACK unless the two groups are identical. Discovery-only destinations are tried best-effort: they cannot satisfy a required ACK, do not block readiness, and are not queued for retry. URLs already covered by a required group are not tried again for discovery; discovery-only URLs are not advertised as read/write or inbox role tags. A failed required group does not stop other lists from being attempted. An unchanged configuration retries only unacknowledged groups with the original signed events. Key metadata keeps its existing separate write/DM ACK rules. Command synchronization requires successful queries and publication on every configured write relay. See [command synchronization](NIP-CD.md) and [messaging key configuration](KEYS.md).

## Readiness and delivery

- **Inbox startup.** One DM relay must finish its initial read window (real EOSE or the long-lived inbox fallback below) and finish its initial recovery attempt. Other replicas can continue reconnecting. If all initial attempts fail, startup rejects. See [recovery](RECOVERY.md).
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

Public kind 1/1111 subscriptions require `publicInbox:{relays:[...]}` independently of DM roles and never inherit a default public firehose. Only currently declared public kinds are subscribed. Replicas reconnect through the shared managed subscription layer; initial history is not executed; the no-EOSE fallback below uses a conservative authenticated timestamp boundary. Replies route to configured write relays and the configured source relay, not arbitrary relay hints. Public thread lookups use the explicit inbox relay set and bounded query budgets. See [public input](PUBLIC.md).

## Current subscription health and initial recovery

Physical connection health, subscription usability and initial read completion are separate. The built-in pool considers a relay connected only while its current WebSocket is OPEN; EOSE, REQ rejection and AUTH completion are not connection signals. Heartbeat failure retires the socket. An OPEN socket waiting for EOSE remains connected, but an OPEN socket does not repair a failed REQ. These are internal checks, with no new public status API. A custom Transport without a physical socket probe remains unknown and uses its own subscription lifecycle; Chirli never infers its socket state from EOSE.

Failed subscription attempts are removed immediately and late callbacks are fenced. With `reconnect:false`, no background retry is scheduled. If all public replicas later become unavailable, explicit `syncCommands()` starts a fresh same-kind attempt. Another usable replica is preserved, even if it is still awaiting its initial read completion. Automatic reconnect remains the default and repairs replica demand independently with the existing backoff.

Initial reads and reconnect scans can deliver DMs at or after first activation through the same middleware and router as live DMs. They can also restore eligible outgoing self copies and retry pending outgoing publications. They never rerun a previously claimed business input. Stop fences delayed recovery and cancels reconnect demand.

### Relays that omit EOSE

Only long-lived DM and public inbox subscriptions in the built-in transport use a local read-window fallback. After the socket opens and REQ is sent, `eoseTimeoutMs` without EOSE completes that subscription's initial window locally. It neither sends an EOSE frame nor claims the relay sent one. Pending AUTH, CLOSED and disconnect still fail through their normal paths. Real EOSE and local completion settle initialization at most once; real EOSE can still arrive later and restore normal live classification.

Before real EOSE, frames remain transport history and carry an internal local boundary. The verified public-input layer allows execution only when the signed event's `created_at` is strictly later than that boundary. DM business admission is independent of EOSE and uses the verified inner rumor timestamp relative to persisted first activation. The backdated giftwrap timestamp only selects relay query windows. Signature, authenticated identity, scope and deduplication still apply.

This is degraded compatibility, not proof of message ordering: signed timestamps are sender-controlled, clocks can differ, future-dated old messages may pass, and new messages from a slow clock may remain history. Real EOSE behavior is unchanged. Applications requiring a reliable history/live boundary should choose relays that provide EOSE.

Direct Transport subscriptions, bounded queries, command catalog reconciliation, pagination and recovery scans still require **real EOSE**. A timeout does not establish a complete command snapshot, permit withdrawals, or advance a durable recovery checkpoint. Startup stage ordering is unchanged; an initial inbox window is not a physical connection check or an archive-completeness guarantee.

### Source comparison and scope

Read-only source review informed these changes; application state/UI code was not imported:

| Reference | Useful lifecycle pattern | Chirli behavior |
| --- | --- | --- |
| Jumble `src/lib/managed-relay.ts` | Logical subscriptions survive physical sockets; generation checks discard stale callbacks; no-demand/offline paths cancel retry timers | Existing managed demand and generation fencing are retained; current socket state and owned subscription attempts are distinguished from initial read completion |
| Jumble `src/lib/relay-subscription.ts` | Keep read completion, closure and AUTH retry separate | Strict reads retain real EOSE and separate timeout errors; only long-lived inboxes permit an explicitly local window completion |
| Jumble `src/lib/relay-pool-lifecycle.ts` | Browser online/resume hints trigger health checks | DOM/UI hooks are not copied into the headless SDK; applications own process lifecycle |
| PsstPsst `src/services/relay/managed-relay-pool.ts` | Per-relay physical generations, demand-driven retry with jitter, replay, idle release and current subscription status | Existing pooled transport, AUTH replay, per-replica retry, quiet transient diagnostics and stop cancellation remain |
| PsstPsst `src/services/relay/lifecycle-relay.ts` | Failed REQ/AUTH writes retire an unusable socket rather than leave orphan demand | Chirli's existing socket-failure path and transport leases remain responsible for write/disconnect signaling |
| PsstPsst `src/services/dm/gift-wrap-pager.ts`, `src/services/dm/dm.service.ts` | Distinguish first readiness from reconnect; bounded, epoch-fenced history recovery | Recovered DMs since first activation can dispatch once; public subscription readiness and outgoing retries are separate |

Chirli already has independent connect/EOSE/ACK/AUTH deadlines, ping/pong half-open detection, pooled connections, stable-period backoff reset and bounded per-relay DM recovery. This change does not add a second connection manager or mobile foreground/background pause policy. Inbox initialization requires a completed initial window and a settled bounded recovery attempt; neither implies a complete relay archive or confirmed recipient delivery. Long-running production outages, OS sleep/network changes, proxies and real external relays still require deployment validation; local tests use disposable identities and memory/loopback relays only.

### nostr-tools transport

The default transport uses one nostr-tools `AbstractRelay` per configured relay URL for connection setup, WebSocket ping/pong, subscription framing, event validation and publication ACK tracking. A small Node WebSocket adapter preserves the configured path and query when opening the socket, even when the library normalizes its internal URL. There is no parallel connection pool.

| Operation | Shared approach with Jumble and PsstPsst | Chirli-specific behavior |
| --- | --- | --- |
| Queries and subscriptions | Use the library's REQ handling and EOSE timer; keep subscription completion separate from socket health | Observe real EOSE by subscription ID. A long-lived inbox can use the library's timeout; strict catalog, pagination and recovery reads reject timeout or a page that lost wire entries during validation. |
| Publishing and NIP-42 | Use the library's publication and ACK machinery. On authentication, replay the original signed event or subscription demand. | Require a boolean `true` ACK, share in-flight publishes of the same event per relay, and keep authentication scoped to the current challenge and exact relay URL. |
| Reconnect | Preserve logical demand across physical connections and discard callbacks from retired connections | Chirli's managed inbox alone schedules per-relay backoff and recovery. The library's automatic reconnect is disabled so it cannot independently replay the same subscription. |

The adapter does not import browser or mobile lifecycle code. Hosted relay behavior, network changes and long-duration outages should still be validated separately from the local tests.

### Authentication attempts and query isolation

As in Jumble's `src/lib/relay-publication.ts` and PsstPsst's `publishToRelay`, a logical publication has at most one authentication retry and always resends the original signed event. A challenge can arrive without rejecting the original EVENT. In that case Chirli resends through the library's public `send()` while retaining the existing ACK promise; it does not overwrite the library's same-ID ACK slot. Concurrent same-event callers share one physical attempt and one resend. Neither authentication nor retransmission renews the overall operation deadline. A new challenge cannot make a publication loop indefinitely.

Each replacement REQ receives a fresh physical subscription ID, as in the reference clients' resubscribe paths. Retired IDs, callbacks and EOSE frames cannot complete its replacement. A strict query clears its local page buffer and wire/accepted counters for each actual attempt, returning only the attempt completed by real EOSE. Per-relay merge behavior is unchanged. Validation drops still fail strict reads rather than turning a saturated dirty page into a short complete page.

The installed library caches `auth()` across challenges. Chirli therefore builds the exact-URL NIP-42 template, validates the signer's result, and uses the library publication/ACK machinery with an AUTH-only send adaptation. ACKs must be exactly boolean `true`. This uses no private library fields and creates no additional physical connection. The library alone owns subscription EOSE timers; cancellation detaches `oneose`, calls public `receivedEose()` solely to clear that timer, and closes the subscription without claiming a wire EOSE.

### Malformed-frame logging boundary

The adapter performs a native JSON syntax preflight, rejects non-array/unknown controls, and normalizes a non-string CLOSED reason into a constant safe rejection. EVENT framing is canonicalized before the library's fast header scanner; Nostr verification and delivery remain in nostr-tools. Tests include truncated/invalid EVENT JSON, malformed EVENT shapes, unusual whitespace and fake query tokens/content and verify that these paths do not invoke the dependency's raw-frame/URL logger. The library's own relay label is origin-only; the actual socket and NIP-42 relay tag still use the exact configured URL.

There is a deliberate cost: valid EVENT JSON is decoded by the syntax preflight and again by nostr-tools. This small native framing guard is needed because the installed dependency has no public logger-suppression hook for parser failures. It does not add a second Nostr dispatcher, signature implementation, physical pool or EOSE timer. No global console patch or private library field is used. The previously reproduced malformed-EVENT URL-query warning path is covered by regressions; this is not an independent audit of every future dependency diagnostic.

Closing pending operations fences their results, but nostr-tools 2.26.0 can retain ACK/keepalive timeout handles until their configured deadline. This may briefly delay Node process exit; Chirli does not reach into private timer maps to cancel them. Browser/mobile background scheduling and network-online state from the reference apps are not transplanted into this headless SDK.
