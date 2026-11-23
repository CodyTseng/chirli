import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { DEFAULT_BLOSSOM_SERVERS } from './defaults.js';
import { signChecked, type Identity } from './protocol.js';

const maxFileBytes = 64 * 1024 * 1024;
const maxDescriptorBytes = 16 * 1024;
const uploadTimeoutMs = 60_000;
const mirrorTimeoutMs = 10_000;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const loopbackHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

function httpUrl(value: string): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || (loopbackHost(url.hostname) && url.protocol === 'http:')) &&
        !url.username && !url.password && !url.search && !url.hash) return url;
  } catch { /* Invalid URL */ }
}

export function normalizeBlossomServers(values: readonly string[] | undefined): string[] {
  values ??= DEFAULT_BLOSSOM_SERVERS;
  if (!Array.isArray(values)) throw new TypeError('blossomServers must be an array of HTTP(S) URLs');
  const servers = Array.from(values, value => {
    const url = httpUrl(value);
    if (!url) throw new TypeError('Blossom URLs must use HTTPS (HTTP is allowed on loopback), without credentials, query or fragment');
    return url.pathname === '/' ? url.href : url.href.replace(/\/+$/, '');
  });
  return [...new Set(servers)];
}

/** Additional trusted HTTPS origins that may host a server's blob descriptors. */
export function normalizeBlossomDownloadOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  if (values === undefined) return new Set();
  if (!Array.isArray(values)) throw new TypeError('blossomDownloadOrigins must be an array of HTTPS origins');
  return new Set(Array.from(values, value => {
    const url = httpUrl(value);
    if (!url || url.protocol !== 'https:' || url.pathname !== '/' || loopbackHost(url.hostname)) {
      throw new TypeError('blossomDownloadOrigins must contain HTTPS origins, without paths, credentials, queries or fragments');
    }
    return url.origin;
  }));
}

export interface UploadFileOptions {
  /** MIME type of exactly the bytes to upload, default application/octet-stream. */
  mimeType?: string;
}

export interface UploadFileResult {
  url: string;
  sha256: string;
  size: number;
  mimeType: string;
}

export interface SendFileOptions {
  /** MIME type inside the encrypted message, default application/octet-stream. */
  mimeType?: string;
  /** Optional filename inside the encrypted message. */
  name?: string;
  /** ID of the decrypted parent message. */
  replyTo?: string;
}

export type ReplyFileOptions = Omit<SendFileOptions, 'replyTo'>;

function validateSize(data: Uint8Array, overhead = 0) {
  if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength + overhead > maxFileBytes) {
    throw new TypeError('File must be a nonempty Uint8Array with an upload size of at most 64 MiB');
  }
}

function validateMimeType(mimeType: string) {
  if (typeof mimeType !== 'string' || mimeType.length > 127 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
    throw new TypeError('Invalid file MIME type');
  }
}

export function snapshotFile(data: Uint8Array): Buffer<ArrayBuffer> {
  validateSize(data);
  return Buffer.from(data);
}

export function encryptAttachment(data: Uint8Array, { mimeType = 'application/octet-stream', name }: SendFileOptions) {
  validateSize(data, 16);
  validateMimeType(mimeType);
  if (name !== undefined && (typeof name !== 'string' || !name.length || Buffer.byteLength(name) > 255 || /[\x00-\x1f\x7f]/.test(name))) {
    throw new TypeError('Attachment name must be nonempty, without control characters, and at most 255 UTF-8 bytes');
  }
  const key = randomBytes(32), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const bytes = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return {
    bytes,
    tags: [
      ['file-type', mimeType], ['encryption-algorithm', 'aes-gcm'],
      ['decryption-key', key.toString('hex')], ['decryption-nonce', nonce.toString('hex')],
      ['ox', hash(data)], ['plain-size', String(data.byteLength)],
      ...(name === undefined ? [] : [['name', name]]),
    ],
  };
}

async function descriptor(
  response: Response, sha256: string, size: number, server: string, downloadOrigins: ReadonlySet<string>,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Blossom descriptor');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxDescriptorBytes) throw new Error('Blossom descriptor too large');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    url?: unknown; sha256?: unknown; size?: unknown;
  } | null;
  const url = typeof input?.url === 'string' ? httpUrl(input.url) : undefined;
  const serverOrigin = new URL(server).origin;
  const trustedOrigin = url && (url.origin === serverOrigin ||
    (!loopbackHost(url.hostname) && downloadOrigins.has(url.origin)));
  const filenameHash = url?.pathname.split('/').at(-1)?.match(/^([0-9a-f]{64})(?:\.[a-z0-9_-]+)?$/i)?.[1].toLowerCase();
  if (!url || !trustedOrigin || filenameHash !== sha256 || input?.sha256 !== sha256 || input.size !== size) {
    throw new Error('Invalid Blossom upload descriptor');
  }
  return url.href;
}

type PutOperation = 'upload' | 'mirror';

async function uploadAuthorization(identity: Identity, servers: readonly string[], sha256: string, size: number) {
  const hosts = [...new Set(servers.map(server => new URL(server).hostname))];
  const now = Math.floor(Date.now() / 1000), expiration = now + 300;
  const event = await signChecked(identity, {
    kind: 24242, created_at: now, content: 'Upload file to Blossom',
    tags: [['t', 'upload'], ['x', sha256], ['size', String(size)],
      ...hosts.map(host => ['server', host]), ['expiration', String(expiration)]],
  });
  const token = Buffer.from(JSON.stringify(event));
  return { base64url: token.toString('base64url'), base64: token.toString('base64'), expiresAt: expiration * 1000 };
}

async function putBlossom(
  authorization: Awaited<ReturnType<typeof uploadAuthorization>>,
  server: string,
  operation: PutOperation,
  body: Buffer<ArrayBuffer>,
  headers: Record<string, string>,
  sha256: string,
  size: number,
  downloadOrigins: ReadonlySet<string>,
): Promise<string | undefined> {
  const remaining = authorization.expiresAt - Date.now();
  if (remaining <= 0) throw new Error('Blossom authorization expired while waiting for the signer');
  const signal = AbortSignal.timeout(Math.min(remaining, operation === 'mirror' ? mirrorTimeoutMs : uploadTimeoutMs));
  const put = (encoding: 'base64url' | 'base64') => fetch(server.replace(/\/+$/, '') + '/' + operation, {
    method: 'PUT', redirect: 'error', signal, body,
    headers: {
      ...headers,
      authorization: 'Nostr ' + authorization[encoding],
      'content-length': String(body.length),
      'x-sha-256': sha256,
    },
  });
  try {
    let response = await put('base64url');
    if ((response.status === 400 || response.status === 401) && authorization.base64url !== authorization.base64) {
      void response.body?.cancel().catch(() => {});
      response = await put('base64');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return;
    }
    return await descriptor(response, sha256, size, server, downloadOrigins);
  } catch { /* Do not copy server responses or tokens into errors. */ }
}

/** Use only configured servers, in priority order. Auth is not published to relays. */
export async function uploadFile(identity: Identity, servers: readonly string[], downloadOrigins: ReadonlySet<string>, data: Uint8Array,
  { mimeType = 'application/octet-stream' }: UploadFileOptions = {},
): Promise<UploadFileResult> {
  if (!servers.length) throw new Error('Configure blossomServers before uploading files');
  validateMimeType(mimeType);
  const bytes = snapshotFile(data), size = bytes.length, sha256 = hash(bytes);
  let authorization: Awaited<ReturnType<typeof uploadAuthorization>> | undefined;
  for (const [index, server] of servers.entries()) {
    if (!authorization || authorization.expiresAt - Date.now() <= uploadTimeoutMs + mirrorTimeoutMs) {
      authorization = await uploadAuthorization(identity, servers.slice(index), sha256, size);
    }
    const signed = authorization;
    const url = await putBlossom(signed, server, 'upload', bytes, { 'content-type': mimeType }, sha256, size, downloadOrigins);
    if (!url) continue;

    // A descriptor may point at a CDN. Do not instruct another server to fetch an
    // arbitrary origin chosen by the descriptor; the configured primary serves
    // the same blob via the standard raw-hash endpoint.
    const source = server.replace(/\/+$/, '') + '/' + sha256;
    const body = Buffer.from(JSON.stringify({ url: source }));
    const targets = servers.slice(index + 1).filter(target =>
      !loopbackHost(new URL(source).hostname) || loopbackHost(new URL(target).hostname));
    await Promise.allSettled(targets.map(target =>
      putBlossom(signed, target, 'mirror', body, {
        'content-type': 'application/json',
        'x-content-type': mimeType,
        'x-content-length': String(size),
      }, sha256, size, downloadOrigins)));
    return { url, sha256, size, mimeType };
  }
  throw new Error('No configured Blossom server accepted the file');
}
