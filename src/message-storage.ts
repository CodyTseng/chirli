import type { MessageState } from "./storage.js";

/** Message payload and its processing state form one durable record. */
export interface MessageStorageEntry {
	id: string;
	conversation: string;
	timestamp: number;
	/** SDK-encoded bytes; preserve them without decoding or rewriting. */
	payload: string;
	state: MessageState;
}

export interface MessageStorageQuery {
	id?: string;
	conversation?: string;
	states?: readonly MessageState[];
	/** oldest: time ASC, ID ASC; newest: time DESC, ID ASC; recovery: time ASC, ID DESC. */
	order?: "oldest" | "newest" | "recovery";
	/** Exclusive position in the requested order. */
	cursor?: { timestamp: number; id: string };
	limit?: number;
}

/** Synchronous message persistence, including deduplication and processing state. */
export interface MessageStorage {
	/** Atomically insert once by account + ID. A duplicate returns false without changes. */
	insert(account: string, message: MessageStorageEntry): boolean;
	/** Apply filters, ordering, cursors and limits inside the database; return detached rows. */
	query(account: string, options?: MessageStorageQuery): MessageStorageEntry[];
	/** Update only the state of an existing account + ID; never create or replace a message. */
	updateState(account: string, id: string, state: MessageState): void;
}
