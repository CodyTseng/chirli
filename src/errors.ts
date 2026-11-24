/** Sanitized operational failure: remote responses and credential strings are not included. */
export class SignerError extends Error {
  constructor(
    readonly operation: string,
    readonly code:
      | "SIGNER_FAILED"
      | "SIGNER_TIMEOUT"
      | "SIGNER_CLOSED" = "SIGNER_FAILED",
  ) {
    super(`Signer ${operation} failed (${code})`);
    this.name = "SignerError";
  }
}

/** Compatibility never silently replaces a known unrelated account encryption declaration. */
export class Nip4eCompatibilityError extends Error {
  constructor(
    readonly code: "NIP4E_KEY_CONFLICT" | "NIP4E_DECLARATION_INVALID",
  ) {
    super(
      `Cannot use the configured encryption key: existing NIP-4E declaration conflicts or is invalid (${code}). Keep the declared key, use a separate identity, or explicitly migrate a locally held key with announce({replaceEncryptionKey}).`,
    );
    this.name = "Nip4eCompatibilityError";
  }
}

/** Never reinterpret existing ciphertext as plaintext or silently change an account's storage mode. */
export class StorageEncryptionError extends Error {
  constructor(readonly code: "STORAGE_KEY_REQUIRED" | "STORAGE_MODE_MISMATCH") {
    super(
      code === "STORAGE_KEY_REQUIRED"
        ? "Existing encrypted data requires its original storageKey."
        : "Existing plaintext data cannot be opened as encrypted; use its original mode or explicitly migrate to a separate database.",
    );
    this.name = "StorageEncryptionError";
  }
}

export type RelayOperation =
  | "connect"
  | "subscribe"
  | "publish"
  | "auth"
  | "history";

export type RelayErrorCode =
  | "RELAY_CONNECTION_FAILED"
  | "RELAY_CONNECT_TIMEOUT"
  | "RELAY_HTTP_REJECTED"
  | "RELAY_EOSE_TIMEOUT"
  | "RELAY_ACK_TIMEOUT"
  | "RELAY_CLOSED"
  | "RELAY_AUTH_REQUIRED"
  | "RELAY_AUTH_TIMEOUT"
  | "RELAY_AUTH_REJECTED"
  | "RELAY_AUTH_SIGNING_FAILED"
  | "RELAY_SUBSCRIPTION_REJECTED"
  | "RELAY_SUBSCRIPTION_FAILED"
  | "RELAY_EVENT_REJECTED"
  | "RELAY_HISTORY_INCOMPLETE";

export interface RelayErrorDetails {
  relay: string;
  operation: RelayOperation;
  code: RelayErrorCode;
  networkCode?: string;
  statusCode?: number;
  closeCode?: number;
  eventKind?: number;
  reason?: string;
  historyReason?: "page-limit" | "boundary-overflow" | "query-failed";
}

const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "EPROTO",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const reasonCodes = new Set([
  "auth-required",
  "restricted",
  "blocked",
  "rate-limited",
  "pow",
  "payment-required",
  "duplicate",
  "invalid",
  "error",
]);

/** Diagnostic metadata only: no query/path/credentials, raw relay reason, frame, or plaintext. */
export class RelayError extends Error {
  readonly relay: string;
  readonly operation: RelayOperation;
  readonly code: RelayErrorCode;
  readonly networkCode?: string;
  readonly statusCode?: number;
  readonly closeCode?: number;
  readonly eventKind?: number;
  readonly reason?: string;
  readonly historyReason?: RelayErrorDetails["historyReason"];

  constructor(message: string, details: RelayErrorDetails) {
    let relay = "(invalid relay URL)";
    try {
      const url = new URL(details.relay);
      if (["ws:", "wss:"].includes(url.protocol)) {
        relay = url.origin;
      }
    } catch {}
    super(`${message} [${relay}] (${details.code})`);
    this.name = "RelayError";
    this.relay = relay;
    this.operation = details.operation;
    this.code = details.code;
    if (details.networkCode && networkCodes.has(details.networkCode)) {
      this.networkCode = details.networkCode;
    }
    if (
      typeof details.statusCode === "number" &&
      Number.isInteger(details.statusCode) &&
      details.statusCode >= 100 &&
      details.statusCode <= 599
    ) {
      this.statusCode = details.statusCode;
    }
    if (
      typeof details.closeCode === "number" &&
      Number.isInteger(details.closeCode) &&
      details.closeCode >= 1000 &&
      details.closeCode <= 4999
    ) {
      this.closeCode = details.closeCode;
    }
    if (
      typeof details.eventKind === "number" &&
      Number.isInteger(details.eventKind) &&
      details.eventKind >= 0 &&
      details.eventKind <= 65535
    ) {
      this.eventKind = details.eventKind;
    }
    const reason = details.reason?.split(":")[0];
    if (reason && reasonCodes.has(reason)) {
      this.reason = reason;
    }
    this.historyReason = details.historyReason;
  }
}

/** Terminal input rejection, with no submitted values, raw Zod messages or credentials. */
export class InvalidArgsError extends Error {
  readonly issues: readonly {
    readonly code: string;
    readonly path: readonly string[];
  }[];
  constructor(
    readonly command: string,
    readonly category: "decode" | "validation",
    issues: readonly { code: string; path: readonly string[] }[] = [],
  ) {
    super(`Invalid arguments for /${command}`);
    this.name = "InvalidArgsError";
    this.issues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          code: issue.code,
          path: Object.freeze([...issue.path]),
        }),
      ),
    );
  }
}
