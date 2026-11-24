# Reconnect and history recovery

The Bot manages one inbox subscription per DM relay. Each reconnects independently and can scan for missed IDs and outgoing self copies. Recovery does not replay external messages or store their bodies as conversation history.

## Defaults and configuration

```ts
const bot = new Bot({
  signer,
  reconnect: { maxDelayMs: 60_000, jitter: 0.2, stableResetMs: 30_000 },
  recovery: { pageSize: 500, maxPages: 20, overlapSeconds: 176_400 },
});
await bot.start();
```

| Setting | Default behavior |
| --- | --- |
| Reconnect | Delay steps of 1, 2, 5, 10, 20, 30 and 60 seconds, with jitter and a 60-second cap |
| `reconnect.initialDelayMs` | Specifying it selects exponential backoff |
| `stableResetMs` | Reset failure counts after 30 seconds of an established connection |
| `recovery.pageSize` and `maxPages` | Query up to 500 events per page and 20 pages per pass |
| `recovery.overlapSeconds` | Two days and one hour to account for randomized giftwrap timestamps |

Set `reconnect: false` to disable automatic reconnect. Set `recovery: false` to skip extra history pages while keeping the inbox subscription's initial history.

## What a recovery pass does

The first pass starts with the configured overlap window. Later passes start at that relay's saved checkpoint minus the overlap. Each pass fixes its upper bound before querying. Checkpoints are scoped to the account, mode and relay.

Pagination includes the oldest returned second in the next request. If a full page cannot move past that boundary, the pass reports `boundary-overflow`. Query failures, page limits and boundary overflow leave the checkpoint unchanged. A retry can read earlier pages again. Deduplication uses the decrypted message ID.

### Live messages and recovered history

Frames before real EOSE normally remain historical, as do all bounded reconnect catch-up and recovery query results. Eligible historical incoming IDs are claimed without storing the message body or running handlers. Historical outgoing self copies can populate local history. Long-lived built-in inbox subscriptions alone can complete locally when a relay omits EOSE; after that boundary, only strictly newer authenticated public-event or decrypted rumor timestamps can enter live processing. See the degraded clock/order guarantees in [relays](RELAYS.md#relays-that-omit-eose). If a historical copy claims the ID before a live duplicate arrives, the duplicate cannot run middleware. A command sent during downtime therefore may neither run nor appear in conversation history.

## Trigger and inspect recovery

```ts
const results = await bot.syncHistory();
```

Call `syncHistory()` on a running Bot. It returns one result per DM relay with its time window, page count and status:

| Status | Meaning |
| --- | --- |
| `window-complete` | The relay's bounded query window drained |
| `incomplete` | See `reason`: `page-limit`, `boundary-overflow` or `query-failed` |
| `aborted` | The pass was interrupted or its replica was unavailable |
| `disabled` | Additional recovery paging is disabled |

Concurrent calls share a relay's active pass. Local `bot.dmHistory()` always reports `coverage: 'local-only'` and `complete: false`. Recovery is bounded and requires the keys needed to decrypt each message. See [key retention](KEYS.md#legacy-count-and-expiration).

## Startup and retries

Startup waits for at least one inbox replica to finish its initial read window (real EOSE or the long-lived inbox fallback) and finish its initial recovery attempt. This initialization gate is separate from physical WebSocket connection health. An incomplete recovery can still leave the Bot ready. Reconnected subscriptions retry pending outbox envelopes with their original ciphertext, IDs and targets. The SDK retries that outgoing work on startup and reconnect, and the live runner also has a periodic [retry timer](../examples/live/README.md).

An established replica's transient network failures get a 30-second recovery window before `onError()` reports one warning for the outage. Initial failures, explicit protocol rejections and history errors are reported immediately. `stop()` and `close()` cancel reconnect demand, delayed warnings and in-progress recovery. See [relays](RELAYS.md) for timeouts and diagnostics.
