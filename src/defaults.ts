/** PsstPsst-derived DM defaults; nip17.com intentionally excluded. Availability is not guaranteed. */
export const DEFAULT_DM_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.psstpsst.chat/',
  'wss://nos.lol/',
  'wss://relay.ditto.pub/',
]);

/** PsstPsst's loadAccountReadRelays/loadAccountWriteRelays fall back to DISCOVERY_RELAYS. */
export const DEFAULT_READ_RELAYS: readonly string[] = Object.freeze([
  'wss://nos.lol/', 'wss://relay.primal.net/', 'wss://relay.ditto.pub/', 'wss://offchain.pub/',
]);

export const DEFAULT_WRITE_RELAYS: readonly string[] = Object.freeze([...DEFAULT_READ_RELAYS]);
