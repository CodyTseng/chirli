import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { hexKey, validTimestamp } from './protocol.js';

export const COMMAND_DEFINITION_KIND = 31992;

export type CommandArgumentType = 'pubkey' | 'event' | 'address' | 'relay' | 'number' | 'bool' | 'enum' | 'word' | 'text';

export interface CommandArgument {
  name: string;
  type: CommandArgumentType;
  required: boolean;
  label: string;
  choices?: readonly string[];
}

export interface CommandDefinition {
  id: string;
  command: string;
  title: string;
  description: string;
  args?: readonly CommandArgument[];
  scopes?: readonly string[];
}

/** Local command coordinates are derived from the trigger; custom identifiers are forbidden. */
export type BotCommandDefinition = Omit<CommandDefinition, 'id' | 'scopes' | 'title' | 'description'> & { id?: never; scopes: readonly string[]; title?: string; description?: string };

export interface CommandAddress {
  kind: number;
  pubkey: string;
  identifier: string;
  relays: string[];
}

export type CommandValue = string | bigint | boolean | CommandAddress;

type ParsedArgument<A extends CommandArgument, T extends CommandArgumentType = A['type']> =
  T extends 'number' ? bigint :
  T extends 'bool' ? boolean :
  T extends 'address' ? CommandAddress :
  T extends 'enum' ? A extends { choices: readonly (infer Choice extends string)[] } ? Choice : string :
  string;

/** Infer named values from a literal schema. Dynamic definitions retain a safe lookup type. */
export type CommandArgs<D extends string | BotCommandDefinition> =
  D extends string ? { readonly text: string | undefined } :
  D extends { args: readonly CommandArgument[] } ? {
    readonly [A in D['args'][number] as A['name']]:
      string extends A['name'] ? ParsedArgument<A> | undefined :
      A['required'] extends true ? ParsedArgument<A> : ParsedArgument<A> | undefined;
  } :
  'args' extends keyof D ? Readonly<Record<string, CommandValue | undefined>> :
  Record<never, never>;

export interface CommandEvent {
  kind: number;
  pubkey: string;
  tags: string[][];
  content: string;
}

export interface CommandMatchContext {
  executor: string;
  relay?: string;
}

export interface CommandInvocation<Args = Record<string, CommandValue | undefined>> {
  definition: CommandDefinition;
  qualifier?: string;
  args: Args;
  rawArgs: Record<string, string | undefined>;
}

export type CommandParseResult = {
  status: 'matched';
  invocation: CommandInvocation;
} | {
  status: 'not-matched';
} | {
  status: 'invalid';
  reason: string;
};

export interface PublishedCommand {
  address: string;
  executor: string;
  definition: CommandDefinition;
  event: Event;
}

export interface CommandDiscoveryResult {
  commands: PublishedCommand[];
  retired: {
    address: string;
    reason: 'deleted' | 'invalid-definition';
  }[];
  coverage: 'relay-snapshot';
  complete: false;
}

export interface DiscoverCommandsOptions {
  authors: string[];
  relays: string[];
  ids?: string[];
  limit?: number;
}


const types = new Set<CommandArgumentType>(['pubkey', 'event', 'address', 'relay', 'number', 'bool', 'enum', 'word', 'text']);

export function commandRelayURL(value: string): string {
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error();
    }
    return url.toString();
  }
  catch {
    throw new TypeError('Invalid command relay URL');
  }
}

export function commandAddress(executor: string, id: string): string {
  if (!hexKey(executor) || typeof id !== 'string') {
    throw new TypeError('Invalid command address');
  }
  return `${COMMAND_DEFINITION_KIND}:${executor}:${id}`;
}

type Scope = {
  group: string;
  matches(event: CommandEvent, context: {
    relay?: string;
  }): boolean;
};

function scope(value: string): Scope {
  const colon = value.indexOf(':'), type = value.slice(0, colon), rest = value.slice(colon + 1);
  if (colon < 1 || !rest) {
    throw new TypeError('Invalid command scope');
  }
  if (type === 'kind' && /^[0-9]+$/.test(rest) && Number.isSafeInteger(+rest) && +rest <= 65535) {
    return {
      group: type, matches: event => event.kind === +rest
    };
  }
  if (type === 'author' && hexKey(rest)) {
    return {
      group: type, matches: event => event.pubkey === rest
    };
  }
  if (type === 'relay') {
    const expected = commandRelayURL(rest);
    return {
      group: type, matches: (_event, context) => {
        try {
          return context.relay !== undefined && commandRelayURL(context.relay) === expected;
        }
        catch {
          return false;
        }
      }
    };
  }
  if (type === 'tag') {
    const split = rest.indexOf(':'), name = split === -1 ? rest : rest.slice(0, split), expected = split === -1 ? undefined : rest.slice(split + 1);
    if (!name) {
      throw new TypeError('Invalid tag scope');
    }
    return {
      group: `tag:${name}`, matches: event => event.tags.some(tag => tag[0] === name && (expected === undefined ? typeof tag[1] === 'string' && tag[1].length > 0 : tag[1] === expected))
    };
  }
  throw new TypeError('Unsupported command scope'); // Unknown constraints never become unrestricted.
}

export function validateCommandDefinition(input: CommandDefinition): CommandDefinition {
  if (typeof input.id !== 'string') {
    throw new TypeError('An explicit stable command id (d value) is required');
  }
  if (typeof input.command !== 'string' || !input.command || input.command.startsWith('/') || /[\s@]/u.test(input.command)) {
    throw new TypeError('Invalid command trigger');
  }
  if (typeof input.title !== 'string' || !input.title || typeof input.description !== 'string' || !input.description) {
    throw new TypeError('Command title and description are required');
  }
  const args: readonly CommandArgument[] = input.args ?? [];
  const scopes: readonly string[] = input.scopes ?? [];
  if (!Array.isArray(args) || !Array.isArray(scopes)) {
    throw new TypeError('Invalid command arguments or scopes');
  }
  let optional = 0, text = 0;
  const names = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg: CommandArgument = args[i];
    if (!arg || typeof arg.name !== 'string' || !arg.name || names.has(arg.name) || !types.has(arg.type) || typeof arg.required !== 'boolean' || typeof arg.label !== 'string') {
      throw new TypeError('Invalid or duplicate command argument');
    }
    names.add(arg.name);
    if (!arg.required) {
      optional++;
    }
    else if (optional > 0) {
      throw new TypeError('Required arguments must precede optional arguments');
    }
    if (arg.type === 'text') {
      text++;
      if (i !== args.length - 1) {
        throw new TypeError('Text must be the final argument');
      }
    }
    if (arg.type === 'enum') {
      if (!Array.isArray(arg.choices) || !arg.choices.length || arg.choices.some((choice: unknown) => typeof choice !== 'string' || !choice) || new Set(arg.choices).size !== arg.choices.length) {
        throw new TypeError('Enum requires distinct nonempty choices');
      }
    }
    else if (arg.choices !== undefined && arg.choices.length) {
      throw new TypeError('Choices apply only to enum arguments');
    }
  }
  if (optional > 1 || text > 1) {
    throw new TypeError('At most one optional and one text argument are supported by NIP-CD');
  }
  for (const value of scopes) {
    if (typeof value !== 'string') {
      throw new TypeError('Invalid scope');
    }
    scope(value);
  }
  return structuredClone({
    id: input.id,
    command: input.command,
    title: input.title,
    description: input.description,
    args,
    scopes
  });
}

export function encodeCommandDefinition(input: CommandDefinition, createdAt = Math.floor(Date.now() / 1000)): EventTemplate {
  const definition = validateCommandDefinition(input);
  if (!validTimestamp(createdAt)) {
    throw new TypeError('Invalid command definition time');
  }
  return {
    kind: COMMAND_DEFINITION_KIND,
    created_at: createdAt,
    content: '',
    tags: [
      ['d', definition.id], ['command', definition.command], ['title', definition.title], ['description', definition.description],
      ...(definition.args ?? []).map(arg => ['arg', arg.name, arg.type, arg.required ? 'required' : 'optional', arg.label, ...(arg.choices ?? [])]),
      ...(definition.scopes ?? []).map(value => ['s', value]),
    ]
  };
}

function signed(input: Event): Event | undefined {
  try {
    const event: Event = JSON.parse(JSON.stringify(input));
    return validTimestamp(event.created_at) && verifyEvent(event) ? event : undefined;
  }
  catch {
    return;
  }
}

function identifier(event: Event): string {
  return event.tags.find(tag => tag[0] === 'd')?.[1] ?? '';
}

export function decodeCommandDefinition(input: Event): PublishedCommand | undefined {
  const event = signed(input);
  if (!event || event.kind !== COMMAND_DEFINITION_KIND) {
    return;
  }
  try {
    const one = (name: string) => {
      const tags = event.tags.filter(tag => tag[0] === name);
      if (tags.length !== 1 || tags[0].length !== 2) {
        throw new TypeError('Missing or ambiguous command field');
      }
      return tags[0][1];
    };
    const definition = validateCommandDefinition({
      id: one('d'),
      command: one('command'),
      title: one('title'),
      description: one('description'),
      args: event.tags.filter(tag => tag[0] === 'arg').map(tag => {
        if (tag.length < 5 || !['required', 'optional'].includes(tag[3])) {
          throw new TypeError('Invalid arg tag');
        }
        return {
          name: tag[1],
          type: tag[2] as CommandArgumentType,
          required: tag[3] === 'required',
          label: tag[4],
          ...(tag.length > 5 ? {
            choices: tag.slice(5)
          } : {})
        };
      }),
      scopes: event.tags.filter(tag => tag[0] === 's').map(tag => {
        if (tag.length !== 2) {
          throw new TypeError('Invalid scope tag');
        }
        return tag[1];
      }),
    });
    return {
      address: commandAddress(event.pubkey, definition.id),
      executor: event.pubkey,
      definition,
      event
    };
  }
  catch {
    return;
  }
}

export function encodeCommandRevocation(executor: string, id: string, createdAt = Math.floor(Date.now() / 1000)): EventTemplate {
  if (!validTimestamp(createdAt)) {
    throw new TypeError('Invalid command revocation time');
  }
  return {
    kind: 5,
    created_at: createdAt,
    tags: [['a', commandAddress(executor, id)], ['k', String(COMMAND_DEFINITION_KIND)]],
    content: ''
  };
}

/** Select newest signed coordinates first; deleted/malformed latest versions never reveal an older fallback. */
export function selectCommandDefinitions(inputs: Event[], authors: string[], ids?: string[]): CommandDiscoveryResult {
  if (!authors.length || !authors.every(hexKey) || (ids !== undefined && (!ids.length || !ids.every(id => typeof id === 'string')))) {
    throw new TypeError('Explicit command authors and nonempty ID filters are required');
  }
  const events = inputs.map(signed).filter((event): event is Event => !!event && authors.includes(event.pubkey));
  const latest = new Map<string, Event>();
  for (const event of events) {
    if (event.kind !== COMMAND_DEFINITION_KIND || (ids && !ids.includes(identifier(event)))) {
      continue;
    }
    const address = commandAddress(event.pubkey, identifier(event)), previous = latest.get(address);
    if (!previous || event.created_at > previous.created_at || (event.created_at === previous.created_at && event.id < previous.id)) {
      latest.set(address, event);
    }
  }
  const commands: PublishedCommand[] = [], retired: CommandDiscoveryResult['retired'] = [];
  for (const [address, event] of latest) {
    const deleted = events.some(deletion => deletion.kind === 5 && deletion.pubkey === event.pubkey && deletion.tags.some(tag => (tag[0] === 'e' && tag[1] === event.id) || (tag[0] === 'a' && tag[1] === address && deletion.created_at >= event.created_at)));
    if (deleted) {
      retired.push({
        address, reason: 'deleted'
      });
      continue;
    }
    const definition = decodeCommandDefinition(event);
    if (definition) {
      commands.push(definition);
    }
    else {
      retired.push({
        address, reason: 'invalid-definition'
      });
    }
  }
  for (const deletion of events) {
    if (deletion.kind === 5) {
      for (const tag of deletion.tags) {
        if (tag[0] !== 'a' || !tag[1]?.startsWith(`${COMMAND_DEFINITION_KIND}:${deletion.pubkey}:`)) {
          continue;
        }
        const address = tag[1], id = address.slice(`${COMMAND_DEFINITION_KIND}:${deletion.pubkey}:`.length);
        if (!latest.has(address) && (!ids || ids.includes(id)) && !retired.some(item => item.address === address)) {
          retired.push({
            address, reason: 'deleted'
          });
        }
      }
    }
  }
  return {
    commands: commands.sort((a, b) => a.address.localeCompare(b.address)),
    retired,
    coverage: 'relay-snapshot',
    complete: false
  };
}

export function matchesCommandScopes(scopes: readonly string[], event: CommandEvent, context: {
  relay?: string;
} = {}): boolean {
  const groups = new Map<string, Scope[]>();
  for (const value of scopes) {
    const condition = scope(value);
    groups.set(condition.group, [...(groups.get(condition.group) ?? []), condition]);
  }
  return [...groups.values()].every(alternatives => alternatives.some(condition => condition.matches(event, context)));
}

const unprefix = (value: string) => value.replace(/^nostr:/i, '');

function argumentValue(arg: CommandArgument, raw: string): CommandValue {
  const value = unprefix(raw);
  if (arg.type === 'word') {
    return value;
  }
  if (arg.type === 'number') {
    if (!/^[0-9]+$/.test(value)) {
      throw new Error();
    }
    return BigInt(value);
  }
  if (arg.type === 'bool') {
    if (['true', 'yes', '1', 't', 'y'].includes(value)) {
      return true;
    }
    if (['false', 'no', '0', 'f', 'n'].includes(value)) {
      return false;
    }
    throw new Error();
  }
  if (arg.type === 'enum') {
    if (arg.choices?.includes(raw)) {
      return raw;
    }
    if (!arg.choices?.includes(value)) {
      throw new Error();
    }
    return value;
  }
  if (arg.type === 'relay') {
    commandRelayURL(value);
    return value;
  }
  if ((arg.type === 'pubkey' || arg.type === 'event') && /^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }
  const decoded = decode(value);
  if (arg.type === 'pubkey' && decoded.type === 'npub') {
    return decoded.data;
  }
  if (arg.type === 'pubkey' && decoded.type === 'nprofile') {
    return decoded.data.pubkey;
  }
  if (arg.type === 'event' && decoded.type === 'note') {
    return decoded.data;
  }
  if (arg.type === 'event' && decoded.type === 'nevent') {
    return decoded.data.id;
  }
  if (arg.type === 'address' && decoded.type === 'naddr' && Number.isSafeInteger(decoded.data.kind) && decoded.data.kind >= 0 && decoded.data.kind <= 65535 && hexKey(decoded.data.pubkey)) {
    return {
      kind: decoded.data.kind,
      pubkey: decoded.data.pubkey,
      identifier: decoded.data.identifier,
      relays: decoded.data.relays ?? []
    };
  }
  throw new Error();
}

/** Shared index-zero trigger/qualifier parser for simple and schema-defined commands. */
export function parseCommandHead(content: string, command: string, executor: string): {
  status: 'matched';
  cursor: number;
  qualifier?: string;
} | {
  status: 'not-matched';
} | {
  status: 'invalid';
  reason: string;
} {
  const head = /^\/([^\s@]+)/u.exec(content);
  if (!head || head[1] !== command) {
    return {
      status: 'not-matched'
    };
  }
  let cursor = head[0].length, qualifier: string | undefined;
  if (content[cursor] === '@') {
    const token = /^(?:nostr:)?npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+/i.exec(content.slice(cursor + 1));
    if (!token) {
      return {
        status: 'invalid', reason: 'Invalid command qualifier'
      };
    }
    try {
      const decoded = decode(unprefix(token[0]));
      if (decoded.type !== 'npub') {
        throw new Error();
      }
      qualifier = decoded.data;
    }
    catch {
      return {
        status: 'invalid', reason: 'Invalid command qualifier'
      };
    }
    cursor += token[0].length + 1;
    if (cursor < content.length && !/\s/u.test(content[cursor])) {
      return {
        status: 'invalid', reason: 'Expected whitespace after qualifier'
      };
    }
    if (qualifier !== executor) {
      return {
        status: 'not-matched'
      };
    }
  }
  return {
    status: 'matched',
    cursor,
    ...(qualifier ? {
      qualifier
    } : {})
  };
}

export function parseCommand(input: CommandDefinition, event: CommandEvent, context: CommandMatchContext): CommandParseResult {
  const definition = validateCommandDefinition(input), content = event.content;
  const head = parseCommandHead(content, definition.command, context.executor);
  if (head.status !== 'matched') {
    return head;
  }
  let { cursor } = head;
  const { qualifier } = head;
  if (!hexKey(context.executor)) {
    throw new TypeError('Executor pubkey is required');
  }
  if (!matchesCommandScopes(definition.scopes ?? [], event, context)) {
    return {
      status: 'not-matched'
    };
  }
  const args: CommandInvocation['args'] = Object.create(null), rawArgs: CommandInvocation['rawArgs'] = Object.create(null);
  for (const arg of definition.args ?? []) {
    if (arg.type === 'text') {
      // Remove one separator only; preserve every remaining character, including leading whitespace.
      if (cursor < content.length && /\s/u.test(content[cursor])) {
        cursor += content.slice(cursor, cursor + 2) === '\r\n' ? 2 : 1;
      }
      const remainder = content.slice(cursor);
      cursor = content.length;
      if (!remainder && arg.required) {
        return {
          status: 'invalid', reason: `Missing argument: ${arg.name}`
        };
      }
      args[arg.name] = rawArgs[arg.name] = remainder || undefined;
      continue;
    }
    while (cursor < content.length && /\s/u.test(content[cursor]))
      cursor++;
    const token = /^\S+/u.exec(content.slice(cursor));
    if (!token) {
      if (arg.required) {
        return {
          status: 'invalid', reason: `Missing argument: ${arg.name}`
        };
      }
      args[arg.name] = rawArgs[arg.name] = undefined;
      continue;
    }
    cursor += token[0].length;
    rawArgs[arg.name] = token[0];
    try {
      args[arg.name] = argumentValue(arg, token[0]);
    }
    catch {
      return {
        status: 'invalid', reason: `Invalid ${arg.type} argument: ${arg.name}`
      };
    }
  }
  if (content.slice(cursor).trim()) {
    return {
      status: 'invalid', reason: 'Unexpected extra arguments'
    };
  }
  return {
    status: 'matched', invocation: {
      definition,
      qualifier,
      args,
      rawArgs
    }
  };
}
