# Reconnect and history recovery

The Bot manages one inbox subscription per DM relay. Each reconnects independently and can scan for missed DMs and outgoing self copies. Eligible incoming DMs recovered from a relay use the same middleware and handlers as live delivery, without retrying a previously claimed input.

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

When a relay has no checkpoint, its next scan starts at the Bot’s persisted first activation minus the configured overlap. Later passes start at that relay’s saved checkpoint minus the overlap. Scan bounds filter the outer giftwrap’s timestamp, not the inner DM timestamp. Each pass fixes its upper bound before querying; only a complete pass advances the checkpoint. Checkpoints are scoped to the account, mode and relay.

Pagination includes the oldest returned second in the next request. If a full page cannot move past that boundary, the pass reports `boundary-overflow`. Query failures, page limits and boundary overflow leave the checkpoint unchanged. A retry can read earlier pages again. Deduplication uses the decrypted message ID.

### Live messages and recovered history

The SDK saves the first DM activation time per bot public key and database before opening its DM inbox. It is reused on subsequent starts. After verification, the SDK discards both incoming DMs and outgoing self copies whose inner rumor timestamp is older than that time. A valid `ms` tag gives millisecond precision; when absent or unusable, a rumor in the same whole second as activation is eligible. Sender clocks can differ.

Once eligible, an incoming DM goes through the same ID claim, middleware and routing whether it arrived live, before EOSE, or in a catch-up query. Failed or denied inputs stay claimed. A later duplicate never reruns the handler. Eligible outgoing self copies can populate local history without middleware. Public command subscriptions keep their separate live/history rules.

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
