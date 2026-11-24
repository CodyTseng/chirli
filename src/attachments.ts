import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { MIMEType } from "node:util";
import { hexKey, type Rumor } from "./protocol.js";

const downloadTimeoutMs = 60_000;
const authTagBytes = 16;

export interface FileAttachment {
  readonly url: string;
  readonly mimeType: string;
  readonly name?: string;
  readonly encryptedSha256: string;
  readonly plaintextSha256?: string;
  readonly encryptedSize?: number;
  readonly plaintextSize?: number;
  download(): Promise<FileDownloadResult>;
}

export type FileDownloadErrorCode =
  | "DOWNLOAD_FAILED"
  | "INTEGRITY_CHECK_FAILED"
  | "DECRYPTION_FAILED"
  | "STORAGE_FAILED"
  | "INPUT_NOT_ADMITTED";

export interface FileDownloadError {
  readonly code: FileDownloadErrorCode;
  readonly message: string;
  readonly status?: number;
}

export type FileDownloadResult =
  | { file: File; error: null }
  | { file: null; error: FileDownloadError };

type AttachmentMetadata = Omit<FileAttachment, "download">;
interface AttachmentDescriptor {
  metadata: AttachmentMetadata;
  key: string;
  nonce: string;
  fallbackUrls: string[];
}

function downloadUrl(value: string): URL | undefined {
  if (!value || value.length > 2048 || /\s/.test(value)) return;
  try {
    const url = new URL(value);
    if (
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.hash
    ) {
      return url;
    }
  } catch {
    // Invalid URL.
  }
}

function sizeTag(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

function fileMimeType(value: string | undefined): string | undefined {
  if (!value || value.length > 1024 || !/^[\t\x20-\x7e]+$/.test(value)) return;
  try {
    return new MIMEType(value).toString();
  } catch {
    return;
  }
}

export function parseAttachment(
  rumor: Rumor,
): AttachmentDescriptor | undefined {
  if (rumor.kind !== 15 || !hexKey(rumor.id) || !downloadUrl(rumor.content))
    return;
  const single = new Map<string, string>();
  const fields = new Set([
    "file-type",
    "name",
    "x",
    "ox",
    "size",
    "plain-size",
    "encryption-algorithm",
    "decryption-key",
    "decryption-nonce",
  ]);
  const fallbackUrls: string[] = [];
  for (const [tag, value] of rumor.tags) {
    if (tag === "fallback" && typeof value === "string" && downloadUrl(value)) {
      if (fallbackUrls.length < 5 && !fallbackUrls.includes(value))
        fallbackUrls.push(value);
    }
    if (!fields.has(tag)) continue;
    if (single.has(tag) || typeof value !== "string" || !value) return;
    single.set(tag, value);
  }
  const mimeType = fileMimeType(single.get("file-type"));
  const encryptedSha256 = single.get("x")?.toLowerCase();
  const plaintextSha256 = single.get("ox")?.toLowerCase();
  const key = single.get("decryption-key");
  const nonce = single.get("decryption-nonce");
  if (
    !mimeType ||
    !hexKey(encryptedSha256) ||
    (plaintextSha256 !== undefined && !hexKey(plaintextSha256)) ||
    single.get("encryption-algorithm") !== "aes-gcm" ||
    !key ||
    !/^[0-9a-f]{64}$/i.test(key) ||
    !nonce ||
    !/^[0-9a-f]{24}$/i.test(nonce)
  )
    return;
  const encryptedSize = sizeTag(single.get("size") ?? "");
  const plaintextSize = sizeTag(single.get("plain-size") ?? "");
  const name = single.get("name");
  const safeName =
    name &&
    name !== "." &&
    name !== ".." &&
    Buffer.byteLength(name) <= 255 &&
    !/[\\/]/.test(name) &&
    [...name].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
      ? name
      : undefined;
  return {
    key,
    nonce,
    fallbackUrls,
    metadata: {
      url: rumor.content,
      mimeType,
      encryptedSha256,
      ...(plaintextSha256 === undefined ? {} : { plaintextSha256 }),
      ...(encryptedSize === undefined ? {} : { encryptedSize }),
      ...(plaintextSize === undefined ? {} : { plaintextSize }),
      ...(safeName === undefined ? {} : { name: safeName }),
    },
  };
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const failure = (
  code: FileDownloadErrorCode,
  message: string,
  status?: number,
): { file: null; error: FileDownloadError } => ({
  file: null,
  error: { code, message, ...(status === undefined ? {} : { status }) },
});

class DownloadFailure extends Error {
  constructor(readonly result: ReturnType<typeof failure>) {
    super(result.error.message);
  }
}

async function readRegularFile(path: string, limit = Infinity) {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) return;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) return;
      offset += bytesRead;
    }
    const end = await file.read(Buffer.alloc(1), 0, 1, offset);
    if (end.bytesRead === 0) return bytes;
  } finally {
    await file.close();
  }
}

async function writeAtomically(path: string, value: Buffer | string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(value);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class AttachmentCache {
  private readonly active = new Map<string, Promise<FileDownloadResult>>();

  constructor(
    private readonly directory: string,
    private readonly origins: ReadonlySet<string>,
  ) {}

  attachment(
    rumor: Rumor,
    admitted: () => boolean,
  ): FileAttachment | undefined {
    const descriptor = parseAttachment(rumor);
    if (!descriptor) return;
    const { id, pubkey } = rumor;
    const { metadata, key, nonce } = descriptor;
    // This binds cache reuse to the authenticated author and the verified encryption metadata.
    const binding = sha256(
      Buffer.from(
        JSON.stringify([
          pubkey,
          metadata.encryptedSha256,
          key.toLowerCase(),
          nonce.toLowerCase(),
          metadata.plaintextSha256,
          metadata.encryptedSize,
          metadata.plaintextSize,
        ]),
      ),
    );
    const attachment: FileAttachment = {
      ...metadata,
      download: async () => {
        try {
          if (!admitted())
            return failure(
              "INPUT_NOT_ADMITTED",
              "The attachment is not available in private history",
            );
        } catch {
          return failure(
            "STORAGE_FAILED",
            "Unable to check private message history",
          );
        }
        const active = this.active.get(id);
        if (active) return active;
        const task = this.download(binding, descriptor).finally(() => {
          this.active.delete(id);
        });
        this.active.set(id, task);
        return task;
      },
    };
    // Keep metadata cloneable and the download capability on the original object.
    Object.defineProperty(attachment, "download", { enumerable: false });
    return Object.freeze(attachment);
  }

  private async download(
    binding: string,
    descriptor: AttachmentDescriptor,
  ): Promise<FileDownloadResult> {
    const { metadata } = descriptor;
    const receipts = join(this.directory, "verified");
    const receipt = join(receipts, binding);
    const asFile = (
      bytes: Buffer<ArrayBuffer>,
      hash: string,
    ): FileDownloadResult => ({
      file: new File([bytes], metadata.name ?? hash, {
        type: metadata.mimeType,
      }),
      error: null,
    });
    try {
      const stored = await readRegularFile(receipt, 64);
      const hash = stored?.toString("ascii");
      // A claimed ox is a lookup hint. The receipt binds the attachment to verified bytes.
      if (
        hexKey(hash) &&
        (!metadata.plaintextSha256 || hash === metadata.plaintextSha256)
      ) {
        const bytes = await readRegularFile(join(this.directory, hash));
        if (bytes && sha256(bytes) === hash) return asFile(bytes, hash);
      }
    } catch {
      return failure("STORAGE_FAILED", "Unable to read the attachment cache");
    }

    let encrypted: Buffer;
    try {
      encrypted = await this.fetchAttachment(descriptor);
    } catch (error) {
      if (error instanceof DownloadFailure) return error.result;
      return failure("DOWNLOAD_FAILED", "Unable to download the attachment");
    }

    let bytes: Buffer<ArrayBuffer>;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(descriptor.key, "hex"),
        Buffer.from(descriptor.nonce, "hex"),
      );
      decipher.setAuthTag(encrypted.subarray(-authTagBytes));
      bytes = Buffer.concat([
        decipher.update(encrypted.subarray(0, -authTagBytes)),
        decipher.final(),
      ]);
    } catch {
      return failure(
        "DECRYPTION_FAILED",
        "Unable to authenticate or decrypt the attachment",
      );
    }
    const hash = sha256(bytes);
    if (
      (metadata.plaintextSha256 !== undefined &&
        hash !== metadata.plaintextSha256) ||
      (metadata.plaintextSize !== undefined &&
        bytes.length !== metadata.plaintextSize)
    )
      return failure(
        "INTEGRITY_CHECK_FAILED",
        "Decrypted attachment failed verification",
      );

    try {
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      await writeAtomically(join(this.directory, hash), bytes);
      await writeAtomically(receipt, hash);
      return asFile(bytes, hash);
    } catch {
      return failure(
        "STORAGE_FAILED",
        "Unable to save the verified attachment",
      );
    }
  }

  private async fetchAttachment({
    metadata,
    fallbackUrls,
  }: AttachmentDescriptor) {
    const urls = [
      ...new Set(
        [metadata.url, ...fallbackUrls].flatMap((value) => {
          const url = downloadUrl(value);
          return url && this.origins.has(url.origin) ? [url.href] : [];
        }),
      ),
    ];
    const deadline = performance.now() + downloadTimeoutMs;
    const totalSignal = AbortSignal.timeout(downloadTimeoutMs);
    let lastError: DownloadFailure | undefined;
    let integrityError: DownloadFailure | undefined;
    for (const [index, url] of urls.entries()) {
      const remainingMs = Math.floor(deadline - performance.now());
      if (totalSignal.aborted || remainingMs <= 0) break;
      const remainingSources = urls.length - index;
      const signal =
        remainingSources === 1
          ? totalSignal
          : AbortSignal.any([
              totalSignal,
              AbortSignal.timeout(Math.floor(remainingMs / remainingSources)),
            ]);
      try {
        const encrypted = await this.fetchSource(url, signal);
        if (
          encrypted.length >= authTagBytes &&
          (metadata.encryptedSize === undefined ||
            encrypted.length === metadata.encryptedSize) &&
          sha256(encrypted) === metadata.encryptedSha256
        )
          return encrypted;
        integrityError = new DownloadFailure(
          failure(
            "INTEGRITY_CHECK_FAILED",
            "Encrypted attachment failed verification",
          ),
        );
      } catch (error) {
        if (error instanceof DownloadFailure) lastError = error;
      }
    }
    throw (
      integrityError ??
      lastError ??
      new DownloadFailure(
        failure("DOWNLOAD_FAILED", "Unable to download the attachment"),
      )
    );
  }

  private async fetchSource(
    value: string,
    signal: AbortSignal,
  ): Promise<Buffer> {
    let url = downloadUrl(value);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!url || !this.origins.has(url.origin)) break;
      const response = await fetch(url, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        url = location ? downloadUrl(new URL(location, url).href) : undefined;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new DownloadFailure(
          failure(
            "DOWNLOAD_FAILED",
            "Attachment host returned an unsuccessful response",
            response.status,
          ),
        );
      }
      return Buffer.from(await response.arrayBuffer());
    }
    throw new DownloadFailure(
      failure(
        "DOWNLOAD_FAILED",
        "Attachment source or redirect is not allowed",
      ),
    );
  }
}
