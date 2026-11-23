import { DEFAULT_DISCOVERY_RELAYS, DEFAULT_DM_RELAYS, DEFAULT_READ_RELAYS, DEFAULT_WRITE_RELAYS } from './defaults.js';
import { websocketURL } from './metadata.js';

export interface RelayRoles {
  dmRelays: string[];
  readRelays: string[];
  writeRelays: string[];
  discoveryRelays: string[];
}

export function relayUnion(...groups: readonly string[][]): string[] {
  const values = new Map<string, string>();
  for (const value of groups.flat()) {
    const normalized = new URL(value).toString();
    if (!values.has(normalized)) {
      values.set(normalized, value);
    }
  }
  return [...values.values()];
}

export function relayRoles(input: {
  relays?: string[];
  dmRelays?: string[];
  readRelays?: string[];
  writeRelays?: string[];
  discoveryRelays?: readonly string[];
}): RelayRoles {
  const list = (value: readonly string[] | undefined, fallback: readonly string[], name: string, empty = false) => {
    if (value !== undefined && (!Array.isArray(value) || (!empty && !value.length) || !Array.from(value).every(websocketURL))) {
      throw new TypeError(`${name} must be ${empty ? 'an' : 'a nonempty'} array of WebSocket URLs`);
    }
    return relayUnion([...(value ?? fallback)]);
  };
  if (input.relays !== undefined) {
    list(input.relays, [], 'relays');
  }
  return {
    dmRelays: list(input.dmRelays ?? input.relays, DEFAULT_DM_RELAYS, 'dmRelays'),
    readRelays: list(input.readRelays ?? input.relays, DEFAULT_READ_RELAYS, 'readRelays', true),
    writeRelays: list(input.writeRelays ?? input.relays, DEFAULT_WRITE_RELAYS, 'writeRelays'),
    discoveryRelays: list(input.discoveryRelays ?? input.relays, DEFAULT_DISCOVERY_RELAYS, 'discoveryRelays', true)
  };
}

/** NIP-65: no marker means both roles, otherwise read/write. Canonical URLs deduplicate aliases. */
export function readWriteTags(read: string[], write: string[]): string[][] {
  const r = new Set(read.map(url => new URL(url).toString())), w = new Set(write.map(url => new URL(url).toString()));
  return [...new Set([...r, ...w])].map(url => ['r', url, ...(r.has(url) && w.has(url) ? [] : [r.has(url) ? 'read' : 'write'])]);
}

/** At least one ACK in each role set, with duplicate/overlapping sets coalesced. */
export function publicationGroups(groups: string[][]): string[][] {
  const seen = new Set<string>();
  return groups.map(group => relayUnion(group)).filter(group => {
    const key = JSON.stringify(group.map(url => new URL(url).toString()).sort());
    if (!group.length || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
