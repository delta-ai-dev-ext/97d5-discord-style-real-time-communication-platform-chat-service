import type { MessageRecord } from "../models/message";
import type { OutboxEntry, OutboxEventType, OutboxPayload } from "../repositories/types";
import { CHAT_MESSAGE_EVENTS_TOPIC } from "./types";

/**
 * Shared platform event envelope (architecture §3.1):
 * `event_id / event_type / occurred_at / producer / version / trace_parent / data`.
 */

export interface EnvelopeInput {
  eventId: string;
  eventType: OutboxEventType;
  occurredAt: Date;
  traceParent: string | null;
  data: Record<string, unknown>;
}

export function buildEnvelope(input: EnvelopeInput): OutboxPayload {
  return {
    event_id: input.eventId,
    event_type: input.eventType,
    occurred_at: input.occurredAt.toISOString(),
    producer: "chat_service",
    version: "1",
    trace_parent: input.traceParent,
    data: input.data,
  };
}

export interface OutboxEntryInput {
  payload: OutboxPayload;
  /** Kafka partition key — always the channel id. */
  partitionKey: string;
  createdAt: Date;
  topic?: string;
}

export function buildOutboxEntry(input: OutboxEntryInput): OutboxEntry {
  return {
    id: input.payload.event_id,
    topic: input.topic ?? CHAT_MESSAGE_EVENTS_TOPIC,
    eventType: input.payload.event_type,
    partitionKey: input.partitionKey,
    payload: input.payload,
    traceParent: input.payload.trace_parent,
    createdAt: input.createdAt,
  };
}

export function serializeEnvelope(payload: OutboxPayload): string {
  return JSON.stringify(payload);
}

export function messageCreatedData(record: MessageRecord): Record<string, unknown> {
  return {
    message_id: record.id,
    channel_id: record.channelId,
    community_id: record.communityId,
    author_user_id: record.authorUserId,
    author_username: record.authorUsername,
    content: record.content,
    client_nonce: record.clientNonce,
    created_at: record.createdAt.toISOString(),
  };
}

export function messageEditedData(record: MessageRecord): Record<string, unknown> {
  return {
    message_id: record.id,
    channel_id: record.channelId,
    community_id: record.communityId,
    content: record.content,
    edited_at: record.editedAt ? record.editedAt.toISOString() : null,
  };
}

export function messageDeletedData(record: MessageRecord): Record<string, unknown> {
  return {
    message_id: record.id,
    channel_id: record.channelId,
    community_id: record.communityId,
  };
}
