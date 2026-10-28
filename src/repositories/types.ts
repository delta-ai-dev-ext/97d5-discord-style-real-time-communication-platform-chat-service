import type { MessageId } from "../models/ids";
import type { MessageRecord } from "../models/message";

/**
 * Persistence contracts. Services depend on these interfaces only, so the
 * drizzle implementations and the in-memory test doubles are interchangeable.
 */

export type OutboxEventType = "message_created" | "message_edited" | "message_deleted";

/** A complete, already-rendered event envelope queued for publication. */
export interface OutboxPayload {
  event_id: string;
  event_type: OutboxEventType;
  occurred_at: string;
  producer: "chat_service";
  version: "1";
  trace_parent: string | null;
  data: Record<string, unknown>;
}

export interface OutboxEntry {
  id: string;
  topic: string;
  eventType: OutboxEventType;
  partitionKey: string;
  payload: OutboxPayload;
  traceParent: string | null;
  createdAt: Date;
}

export interface OutboxRow extends OutboxEntry {
  publishedAt: Date | null;
}

export interface CreateMessageInput {
  message: MessageRecord;
  event: OutboxEntry;
}

export type CreateMessageOutcome =
  | { outcome: "created"; message: MessageRecord }
  | { outcome: "duplicate"; message: MessageRecord };

export interface EditMessageInput {
  channelId: string;
  messageId: MessageId;
  authorUserId: string;
  content: string;
  editedAt: Date;
  event: OutboxEntry;
}

export interface DeleteMessageInput {
  channelId: string;
  messageId: MessageId;
  authorUserId: string;
  deletedAt: Date;
  event: OutboxEntry;
}

export interface ListHistoryInput {
  channelId: string;
  before?: MessageId;
  after?: MessageId;
  limit: number;
}

export interface MessageRepository {
  /**
   * Inserts the message and its outbox event in one transaction.
   * A `(channel_id, author_user_id, client_nonce)` conflict returns the
   * original row as `duplicate` and persists nothing.
   */
  createWithEvent(input: CreateMessageInput): Promise<CreateMessageOutcome>;

  /** Returns the row even when it is soft-deleted (callers decide visibility). */
  findById(channelId: string, messageId: MessageId): Promise<MessageRecord | null>;

  /** Updates content/`edited_at` and writes the outbox event atomically. */
  editWithEvent(input: EditMessageInput): Promise<MessageRecord | null>;

  /** Sets `deleted_at` and writes the outbox event atomically. */
  softDeleteWithEvent(input: DeleteMessageInput): Promise<boolean>;

  /** Non-deleted messages only, ordered per the requested cursor direction. */
  listHistory(input: ListHistoryInput): Promise<MessageRecord[]>;
}

export interface OutboxRepository {
  /** Unpublished rows in `created_at` order, preserving per-channel ordering. */
  fetchUnpublished(limit: number): Promise<OutboxRow[]>;
  markPublished(ids: string[], publishedAt: Date): Promise<void>;
  oldestUnpublishedCreatedAt(): Promise<Date | null>;
}

export interface PurgeRepository {
  isEventProcessed(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
  /** Hard-deletes at most `batchSize` rows for the given channels. */
  purgeChannelMessages(channelIds: string[], batchSize: number): Promise<number>;
}
