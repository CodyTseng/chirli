/** Opaque SDK record: AES-GCM with storageKey, tagged plaintext without it. */
export type StoragePayload = string & { readonly __chirliPayload: unique symbol };
export type MessageState = 'pending' | 'processing' | 'failed' | 'done';
export type OutboxState = 'pending' | 'relay-accepted';

export interface StoredMessage {
  id: string;
  peer: string;
  time: number;
  payload: StoragePayload;
  state: MessageState;
}

export interface StoredOutbox {
  id: string;
  payload: StoragePayload;
  state: OutboxState;
}

export type StorageRecord =
  | { collection: 'messages'; record: StoredMessage }
  | { collection: 'outbox'; record: StoredOutbox };

export interface KeyEvidence { key: string; time: number; id: string }
export interface StoredDeclaration { time: number; id: string; payload: StoragePayload }
export interface MessagePosition { time: number; id: string }

/** Native database filters and an exclusive cursor in the requested sort order. */
export interface MessageQuery {
  id?: string;
  peer?: string;
  states?: readonly MessageState[];
  order?: { time: 'asc' | 'desc'; id: 'asc' | 'desc' };
  cursor?: MessagePosition;
  limit?: number;
}

export interface OutboxQuery {
  id?: string;
  state?: OutboxState;
  limit?: number;
}

/** Synchronous single-writer persistence. Reads are detached; transactions are atomic/durable.
 * Implement query filters, ordering, cursors and limits in the database, not over a full-table read.
 */
export interface StorageAdapter {
  /** Insert once by account + ID. Return false for an existing record without changing it. */
  insert(account: string, value: StorageRecord): boolean;
  queryMessages(account: string, query?: MessageQuery): StoredMessage[];
  queryOutbox(account: string, query?: OutboxQuery): StoredOutbox[];
  updateMessageState(account: string, id: string, state: MessageState): void;
  updateOutboxState(account: string, id: string, state: OutboxState): void;
  getEvidence(account: string, peer: string): KeyEvidence | undefined;
  setEvidence(account: string, peer: string, row: KeyEvidence): void;
  getDeclaration(account: string, peer: string): StoredDeclaration | undefined;
  setDeclaration(account: string, peer: string, row: StoredDeclaration): void;
  markSplitPeer(account: string, peer: string): void;
  isSplitPeer(account: string, peer: string): boolean;
  getSession(account: string, peer: string): StoragePayload | undefined;
  setSession(account: string, peer: string, payload: StoragePayload): void;
  getCheckpoint(account: string, relay: string): number | undefined;
  setCheckpoint(account: string, relay: string, through: number): void;
  getKeyring(identity: string): StoragePayload | undefined;
  setKeyring(identity: string, payload: StoragePayload): void;
  transaction(run: () => void): void;
  close(): void;
}
