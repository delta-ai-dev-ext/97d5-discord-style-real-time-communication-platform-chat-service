import type { AccessDecision } from "../../src/access/types";
import type { SessionClaims } from "../../src/auth/types";
import type { OutboxEntry, OutboxPayload } from "../../src/repositories/types";
import { asMessageId } from "../../src/models/ids";
import type { MessageRecord } from "../../src/models/message";

export const TEST_COMMUNITY_ID = "community-1";
export const TEST_CHANNEL_ID = "channel-1";
export const AUTHOR_ID = "user_author";
export const OTHER_USER_ID = "user_other";

export function buildAccessDecision(overrides: Partial<AccessDecision> = {}): AccessDecision {
  return {
    communityId: TEST_COMMUNITY_ID,
    channelType: "text",
    isMember: true,
    canView: true,
    canReadHistory: true,
    canSend: true,
    timedOutUntil: null,
    banned: false,
    ...overrides,
  };
}

export function buildClaims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return { userId: AUTHOR_ID, username: "author", ...overrides };
}

export function buildMessageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: asMessageId("01JD8W4FQ9Z2X7K3M5A0B1CDEF"),
    channelId: TEST_CHANNEL_ID,
    communityId: TEST_COMMUNITY_ID,
    authorUserId: AUTHOR_ID,
    authorUsername: "author",
    content: "hello world",
    clientNonce: "nonce-1",
    createdAt: new Date("2025-01-01T12:00:00.000Z"),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function buildOutboxPayload(overrides: Partial<OutboxPayload> = {}): OutboxPayload {
  return {
    event_id: "8f14e45f-ceea-4a11-8a11-2b1cd0e5a111",
    event_type: "message_created",
    occurred_at: "2025-01-01T12:00:00.000Z",
    producer: "chat_service",
    version: "1",
    trace_parent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    data: { message_id: "01JD8W4FQ9Z2X7K3M5A0B1CDEF" },
    ...overrides,
  };
}

export function buildOutboxEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "8f14e45f-ceea-4a11-8a11-2b1cd0e5a111",
    topic: "chat_message_events",
    eventType: "message_created",
    partitionKey: TEST_CHANNEL_ID,
    payload: buildOutboxPayload(),
    traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    createdAt: new Date("2025-01-01T12:00:00.000Z"),
    ...overrides,
  };
}
