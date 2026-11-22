# Reconnect and history recovery

The Bot manages one inbox subscription per DM relay. Each reconnects independently and can recover missed messages into local history.

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

Frames before EOSE, reconnect catch-up and recovery query results are all historical. They are stored without running handlers. If a historical copy arrives before a live duplicate, both share one receipt and the message stays historical. A command sent during downtime may therefore appear in history without executing.

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

Concurrent calls share a relay's active pass. Local `history()` always reports `coverage: 'local-only'` and `complete: false`. Recovery is bounded and requires the keys needed to decrypt each message. See [key retention](KEYS.md#legacy-count-and-expiration).

## Startup and retries

Startup waits for at least one inbox replica to reach EOSE and finish its initial recovery attempt. An incomplete recovery can still leave the Bot ready. Reconnected subscriptions retry pending outbox envelopes with their original ciphertext, IDs and targets. The SDK retries on startup and reconnect, and the live runner also has a periodic [retry timer](../examples/live/README.md).

An established replica's transient network failures get a 30-second recovery window before `onError()` reports one warning for the outage. Initial failures, explicit protocol rejections and history errors are reported immediately. `stop()` and `close()` cancel reconnect demand, delayed warnings and in-progress recovery. See [relays](RELAYS.md) for timeouts and diagnostics.
