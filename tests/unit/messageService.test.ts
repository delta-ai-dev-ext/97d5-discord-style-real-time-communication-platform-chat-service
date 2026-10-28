import { describe, expect, it } from "bun:test";
import { Registry } from "prom-client";
import { AppError } from "../../src/errors";
import { createLogger } from "../../src/logger";
import { createMetrics } from "../../src/metrics";
import type { Metrics } from "../../src/metrics";
import { MessageService } from "../../src/services/messageService";
import { asMessageId } from "../../src/models/ids";
import { createTokenBucketRateLimiter } from "../../src/rateLimit";
import type { RateLimiter } from "../../src/rateLimit";
import { AccessClientStub } from "../mocks/accessClientStub";
import {
  AUTHOR_ID,
  OTHER_USER_ID,
  TEST_CHANNEL_ID,
  TEST_COMMUNITY_ID,
  buildAccessDecision,
  buildClaims,
  buildMessageRecord,
} from "../mocks/builders";
import { FakeMessageRepository } from "../mocks/fakeRepositories";
import { accessUnavailable } from "../../src/errors";

const TRACE_PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface Harness {
  service: MessageService;
  repository: FakeMessageRepository;
  access: AccessClientStub;
  limiter: RateLimiter;
  metrics: Metrics;
  advance(ms: number): void;
}

function harness(options: { limitPerMinute?: number } = {}): Harness {
  let currentMs = Date.UTC(2025, 0, 1, 12, 0, 0);
  const repository = new FakeMessageRepository();
  const access = new AccessClientStub();
  const limiter = createTokenBucketRateLimiter({ limitPerMinute: options.limitPerMinute ?? 60 });
  const metrics = createMetrics(new Registry());
  const service = new MessageService({
    repository,
    accessClient: access,
    rateLimiter: limiter,
    metrics,
    logger: createLogger({ level: "error", sink: () => undefined }),
    now: () => {
      currentMs += 1;

      return new Date(currentMs);
    },
  });

  return {
    service,
    repository,
    access,
    limiter,
    metrics,
    advance(ms: number) {
      currentMs += ms;
    },
  };
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error("expected an AppError");
}

const sendParams = (overrides: Record<string, unknown> = {}) => ({
  channelId: TEST_CHANNEL_ID,
  claims: buildClaims(),
  body: { content: "hello world", client_nonce: "nonce-1" },
  traceParent: TRACE_PARENT,
  ...overrides,
});

describe("MessageService.send — persistence and events (US-001)", () => {
  it("persists the message with its outbox event and returns 201", async () => {
    const test = harness();

    const result = await test.service.send(sendParams());

    expect(result.status).toBe(201);
    expect(result.message).toMatchObject({
      channel_id: TEST_CHANNEL_ID,
      community_id: TEST_COMMUNITY_ID,
      author_user_id: AUTHOR_ID,
      author_username: "author",
      content: "hello world",
      client_nonce: "nonce-1",
      edited_at: null,
    });
    expect(result.message.message_id).toHaveLength(26);

    expect(test.repository.records.size).toBe(1);
    expect(test.repository.events).toHaveLength(1);

    const event = test.repository.events[0];
    expect(event?.eventType).toBe("message_created");
    expect(event?.topic).toBe("chat_message_events");
    expect(event?.partitionKey).toBe(TEST_CHANNEL_ID);
    expect(event?.traceParent).toBe(TRACE_PARENT);
    expect(event?.payload).toMatchObject({
      event_type: "message_created",
      producer: "chat_service",
      version: "1",
      trace_parent: TRACE_PARENT,
      data: {
        message_id: result.message.message_id,
        channel_id: TEST_CHANNEL_ID,
        community_id: TEST_COMMUNITY_ID,
        author_user_id: AUTHOR_ID,
        author_username: "author",
        content: "hello world",
        client_nonce: "nonce-1",
      },
    });
    expect(event?.payload.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("counts the send and the channel type", async () => {
    const test = harness();

    await test.service.send(sendParams());

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain('chat_messages_sent_total{channel_type="text"} 1');
  });
});

describe("MessageService.send — nonce idempotency (US-002)", () => {
  it("returns the original row with 200 when the nonce replays", async () => {
    const test = harness();

    const first = await test.service.send(sendParams());
    const replay = await test.service.send(sendParams({ body: { content: "different content", client_nonce: "nonce-1" } }));

    expect(replay.status).toBe(200);
    expect(replay.message.message_id).toBe(first.message.message_id);
    expect(replay.message.content).toBe("hello world");
    expect(test.repository.records.size).toBe(1);
    expect(test.repository.events).toHaveLength(1);
  });

  it("counts nonce replays as deduplicated retries", async () => {
    const test = harness();

    await test.service.send(sendParams());
    await test.service.send(sendParams());

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain("chat_send_retries_deduplicated_total 1");
    expect(exposition).toContain('chat_messages_sent_total{channel_type="text"} 1');
  });

  it("scopes the nonce per channel and author", async () => {
    const test = harness();

    await test.service.send(sendParams());
    const sameChannelOtherAuthor = await test.service.send(sendParams({ claims: buildClaims({ userId: OTHER_USER_ID }) }));
    const otherChannel = await test.service.send(sendParams({ channelId: "channel-2" }));

    expect(sameChannelOtherAuthor.status).toBe(201);
    expect(otherChannel.status).toBe(201);
    expect(test.repository.records.size).toBe(3);
    expect(test.repository.events).toHaveLength(3);
  });

  it("gives every new message a later, sortable id", async () => {
    const test = harness();

    const first = await test.service.send(sendParams({ body: { content: "one", client_nonce: "n1" } }));
    const second = await test.service.send(sendParams({ body: { content: "two", client_nonce: "n2" } }));

    expect(second.message.message_id > first.message.message_id).toBe(true);
  });
});

describe("MessageService.send — rejections", () => {
  it("rejects an active timeout with member_timed_out and persists nothing", async () => {
    const test = harness();
    test.access.setDecision(
      buildAccessDecision({ timedOutUntil: new Date("2025-01-01T12:30:00.000Z") }),
    );

    const error = await expectAppError(test.service.send(sendParams()));

    expect(error.code).toBe("member_timed_out");
    expect(error.details).toEqual({ timed_out_until: "2025-01-01T12:30:00.000Z" });
    expect(test.repository.records.size).toBe(0);
    expect(test.repository.events).toHaveLength(0);

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain('chat_send_rejections_total{reason="timed_out"} 1');
  });

  it("rejects a member without SEND_MESSAGES with missing_permission", async () => {
    const test = harness();
    test.access.setDecision(buildAccessDecision({ canSend: false }));

    const error = await expectAppError(test.service.send(sendParams()));

    expect(error.code).toBe("missing_permission");
    expect(test.repository.records.size).toBe(0);

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain('chat_send_rejections_total{reason="missing_permission"} 1');
  });

  it("rejects a non-member with missing_permission", async () => {
    const test = harness();
    test.access.setDecision(buildAccessDecision({ isMember: false }));

    expect((await expectAppError(test.service.send(sendParams()))).code).toBe("missing_permission");
  });

  it("treats a non-text channel as 404", async () => {
    const test = harness();
    test.access.setDecision(buildAccessDecision({ channelType: "voice" }));

    const error = await expectAppError(test.service.send(sendParams()));

    expect(error.code).toBe("channel_not_found");
    expect(error.httpStatus).toBe(404);
  });

  it("validates the body before calling community_service (422)", async () => {
    const test = harness();

    for (const body of [
      { content: "", client_nonce: "n" },
      { content: "   ", client_nonce: "n" },
      { content: "x".repeat(4001), client_nonce: "n" },
      { content: "ok" },
      { content: "ok", client_nonce: "" },
      { content: "ok", client_nonce: "n".repeat(65) },
      { client_nonce: "n" },
      null,
    ]) {
      const error = await expectAppError(test.service.send(sendParams({ body })));

      expect(error.code).toBe("validation_error");
      expect(error.httpStatus).toBe(422);
    }

    expect(test.access.callCount).toBe(0);
    expect(test.repository.records.size).toBe(0);

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain('chat_send_rejections_total{reason="validation"} 8');
  });

  it("enforces the per-user send rate limit with 429 before the access check", async () => {
    const test = harness({ limitPerMinute: 2 });

    await test.service.send(sendParams({ body: { content: "one", client_nonce: "n1" } }));
    await test.service.send(sendParams({ body: { content: "two", client_nonce: "n2" } }));
    const error = await expectAppError(
      test.service.send(sendParams({ body: { content: "three", client_nonce: "n3" } })),
    );

    expect(error.code).toBe("rate_limited");
    expect(error.httpStatus).toBe(429);
    expect(test.access.callCount).toBe(2);
    expect(test.repository.records.size).toBe(2);
  });

  it("lets a different user send after someone else is rate limited", async () => {
    const test = harness({ limitPerMinute: 1 });

    await test.service.send(sendParams({ body: { content: "one", client_nonce: "n1" } }));
    await expectAppError(test.service.send(sendParams({ body: { content: "two", client_nonce: "n2" } })));

    const other = await test.service.send(
      sendParams({ claims: buildClaims({ userId: OTHER_USER_ID }), body: { content: "hi", client_nonce: "n1" } }),
    );

    expect(other.status).toBe(201);
  });

  it("fails closed when the access check cannot be completed", async () => {
    const test = harness();
    test.access.setError(accessUnavailable());

    const error = await expectAppError(test.service.send(sendParams()));

    expect(error.code).toBe("access_unavailable");
    expect(error.httpStatus).toBe(503);
    expect(test.repository.records.size).toBe(0);
    expect(test.repository.events).toHaveLength(0);
  });

  it("rolls back (no message, no event) when the database write fails", async () => {
    const test = harness();
    test.repository.failNextWrite = new Error("connection reset");

    const error = await expectAppError(test.service.send(sendParams()));

    expect(error.code).toBe("internal_error");
    expect(error.httpStatus).toBe(500);
    expect(test.repository.records.size).toBe(0);
    expect(test.repository.events).toHaveLength(0);
  });
});

describe("MessageService.list — cursor pagination (US-005)", () => {
  async function seedMessages(test: Harness, count: number): Promise<string[]> {
    const ids: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const result = await test.service.send(
        sendParams({ body: { content: `message ${index}`, client_nonce: `nonce-${index}` } }),
      );
      ids.push(result.message.message_id);
    }

    return ids;
  }

  it("returns the newest messages first with a next_cursor for the older page", async () => {
    const test = harness();
    const ids = await seedMessages(test, 3);

    const page = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { limit: "2" },
      traceParent: TRACE_PARENT,
    });

    expect(page.messages.map((message) => message.message_id)).toEqual([ids[2] as string, ids[1] as string]);
    expect(page.next_cursor).toBe(ids[1] as string);
  });

  it("returns a null cursor when the start of history is reached", async () => {
    const test = harness();
    await seedMessages(test, 2);

    const page = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { limit: "5" },
      traceParent: TRACE_PARENT,
    });

    expect(page.messages).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it("pages strictly older messages with before", async () => {
    const test = harness();
    const ids = await seedMessages(test, 4);

    const firstPage = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { limit: "2" },
      traceParent: TRACE_PARENT,
    });
    const secondPage = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { limit: "2", before: firstPage.next_cursor as string },
      traceParent: TRACE_PARENT,
    });

    expect(secondPage.messages.map((message) => message.message_id)).toEqual([ids[1] as string, ids[0] as string]);
    expect(secondPage.next_cursor).toBe(ids[0] as string);

    const thirdPage = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { limit: "2", before: ids[0] as string },
      traceParent: TRACE_PARENT,
    });
    expect(thirdPage.messages).toEqual([]);
    expect(thirdPage.next_cursor).toBeNull();
  });

  it("returns strictly newer messages oldest-first for after (US-006)", async () => {
    const test = harness();
    const ids = await seedMessages(test, 4);

    const backfill = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { after: ids[0] as string, limit: "2" },
      traceParent: TRACE_PARENT,
    });

    expect(backfill.messages.map((message) => message.message_id)).toEqual([ids[1] as string, ids[2] as string]);
    expect(backfill.next_cursor).toBe(ids[2] as string);

    const next = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: { after: backfill.next_cursor as string, limit: "2" },
      traceParent: TRACE_PARENT,
    });

    expect(next.messages.map((message) => message.message_id)).toEqual([ids[3] as string]);
    expect(next.next_cursor).toBeNull();
  });

  it("returns an empty page for an empty channel", async () => {
    const test = harness();

    const page = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: {},
      traceParent: TRACE_PARENT,
    });

    expect(page).toEqual({ messages: [], next_cursor: null });
  });

  it("never returns soft-deleted messages", async () => {
    const test = harness();
    const ids = await seedMessages(test, 2);

    await test.service.remove({
      channelId: TEST_CHANNEL_ID,
      messageId: ids[1] as string,
      claims: buildClaims(),
      traceParent: TRACE_PARENT,
    });

    const page = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: {},
      traceParent: TRACE_PARENT,
    });

    expect(page.messages.map((message) => message.message_id)).toEqual([ids[0] as string]);
  });

  it("checks access on every history read", async () => {
    const test = harness();

    await test.service.list({ channelId: TEST_CHANNEL_ID, claims: buildClaims(), query: {}, traceParent: TRACE_PARENT });
    await test.service.list({ channelId: TEST_CHANNEL_ID, claims: buildClaims(), query: {}, traceParent: TRACE_PARENT });

    expect(test.access.callCount).toBe(2);
    expect(test.access.requests[0]).toEqual({
      channelId: TEST_CHANNEL_ID,
      userId: AUTHOR_ID,
      traceParent: TRACE_PARENT,
    });
  });

  it("requires VIEW_CHANNEL and READ_MESSAGE_HISTORY (US-009)", async () => {
    const test = harness();

    for (const decision of [
      buildAccessDecision({ canView: false }),
      buildAccessDecision({ canReadHistory: false }),
      buildAccessDecision({ isMember: false }),
      buildAccessDecision({ banned: true }),
    ]) {
      test.access.setDecision(decision);
      const error = await expectAppError(
        test.service.list({ channelId: TEST_CHANNEL_ID, claims: buildClaims(), query: {}, traceParent: TRACE_PARENT }),
      );

      expect(error.code).toBe("missing_permission");
      expect(error.httpStatus).toBe(403);
    }
  });

  it("lets a timed-out member read history (US-008)", async () => {
    const test = harness();
    await seedMessages(test, 1);
    test.access.setDecision(buildAccessDecision({ timedOutUntil: new Date("2030-01-01T00:00:00.000Z") }));

    const page = await test.service.list({
      channelId: TEST_CHANNEL_ID,
      claims: buildClaims(),
      query: {},
      traceParent: TRACE_PARENT,
    });

    expect(page.messages).toHaveLength(1);
  });

  it("fails closed on history reads when community_service is unavailable", async () => {
    const test = harness();
    test.access.setError(accessUnavailable());

    const error = await expectAppError(
      test.service.list({ channelId: TEST_CHANNEL_ID, claims: buildClaims(), query: {}, traceParent: TRACE_PARENT }),
    );

    expect(error.code).toBe("access_unavailable");
  });

  it("rejects malformed cursors and out-of-range limits", async () => {
    const test = harness();

    expect(
      (
        await expectAppError(
          test.service.list({
            channelId: TEST_CHANNEL_ID,
            claims: buildClaims(),
            query: { before: "nope" },
            traceParent: TRACE_PARENT,
          }),
        )
      ).code,
    ).toBe("invalid_cursor");

    expect(
      (
        await expectAppError(
          test.service.list({
            channelId: TEST_CHANNEL_ID,
            claims: buildClaims(),
            query: { limit: "101" },
            traceParent: TRACE_PARENT,
          }),
        )
      ).httpStatus,
    ).toBe(400);
  });
});

describe("MessageService.edit — author only (US-003)", () => {
  async function seed(test: Harness): Promise<string> {
    const result = await test.service.send(sendParams());

    return result.message.message_id;
  }

  it("updates content, sets edited_at and emits message_edited", async () => {
    const test = harness();
    const messageId = await seed(test);

    const edited = await test.service.edit({
      channelId: TEST_CHANNEL_ID,
      messageId,
      claims: buildClaims(),
      body: { content: "hello again" },
      traceParent: TRACE_PARENT,
    });

    expect(edited.content).toBe("hello again");
    expect(edited.edited_at).not.toBeNull();
    expect(test.repository.events).toHaveLength(2);
    const event = test.repository.events[1];
    expect(event?.eventType).toBe("message_edited");
    expect(event?.payload.data).toMatchObject({
      message_id: messageId,
      channel_id: TEST_CHANNEL_ID,
      community_id: TEST_COMMUNITY_ID,
      content: "hello again",
    });

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain("chat_messages_edited_total 1");
  });

  it("never calls community_service", async () => {
    const test = harness();
    const messageId = await seed(test);
    const accessCallsBefore = test.access.callCount;

    await test.service.edit({
      channelId: TEST_CHANNEL_ID,
      messageId,
      claims: buildClaims(),
      body: { content: "edit" },
      traceParent: TRACE_PARENT,
    });

    expect(test.access.callCount).toBe(accessCallsBefore);
  });

  it("rejects a non-author with not_message_author and leaves the message untouched", async () => {
    const test = harness();
    const messageId = await seed(test);

    const error = await expectAppError(
      test.service.edit({
        channelId: TEST_CHANNEL_ID,
        messageId,
        claims: buildClaims({ userId: OTHER_USER_ID }),
        body: { content: "hijacked" },
        traceParent: TRACE_PARENT,
      }),
    );

    expect(error.code).toBe("not_message_author");
    expect(error.httpStatus).toBe(403);
    expect(test.repository.records.get(messageId)?.content).toBe("hello world");
    expect(test.repository.events).toHaveLength(1);
  });

  it("returns 404 for unknown, malformed and already-deleted messages", async () => {
    const test = harness();
    const messageId = await seed(test);

    await test.service.remove({
      channelId: TEST_CHANNEL_ID,
      messageId,
      claims: buildClaims(),
      traceParent: TRACE_PARENT,
    });

    for (const candidate of [messageId, "not-a-cursor", "01JD8W4FQ9Z2X7K3M5A0B1CDEZ"]) {
      const error = await expectAppError(
        test.service.edit({
          channelId: TEST_CHANNEL_ID,
          messageId: candidate,
          claims: buildClaims(),
          body: { content: "nope" },
          traceParent: TRACE_PARENT,
        }),
      );

      expect(error.code).toBe("message_not_found");
      expect(error.httpStatus).toBe(404);
    }
  });

  it("returns 404 when the message belongs to another channel", async () => {
    const test = harness();
    const messageId = await seed(test);

    const error = await expectAppError(
      test.service.edit({
        channelId: "channel-2",
        messageId,
        claims: buildClaims(),
        body: { content: "nope" },
        traceParent: TRACE_PARENT,
      }),
    );

    expect(error.code).toBe("message_not_found");
  });

  it("validates the new content (422)", async () => {
    const test = harness();
    const messageId = await seed(test);

    for (const body of [{ content: "" }, { content: "  " }, { content: "x".repeat(4001) }, {}]) {
      const error = await expectAppError(
        test.service.edit({
          channelId: TEST_CHANNEL_ID,
          messageId,
          claims: buildClaims(),
          body,
          traceParent: TRACE_PARENT,
        }),
      );

      expect(error.code).toBe("validation_error");
      expect(error.httpStatus).toBe(422);
    }
  });
});

describe("MessageService.remove — author only (US-004)", () => {
  it("soft-deletes, emits message_deleted and hides the message from history", async () => {
    const test = harness();
    const created = await test.service.send(sendParams());
    const messageId = created.message.message_id;
    const accessCallsBefore = test.access.callCount;

    await test.service.remove({
      channelId: TEST_CHANNEL_ID,
      messageId,
      claims: buildClaims(),
      traceParent: TRACE_PARENT,
    });

    const stored = test.repository.records.get(messageId);
    expect(stored?.deletedAt).not.toBeNull();
    expect(test.access.callCount).toBe(accessCallsBefore);

    const event = test.repository.events[1];
    expect(event?.eventType).toBe("message_deleted");
    expect(event?.payload.data).toEqual({
      message_id: messageId,
      channel_id: TEST_CHANNEL_ID,
      community_id: TEST_COMMUNITY_ID,
    });

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain("chat_messages_deleted_total 1");
  });

  it("rejects a non-author with not_message_author", async () => {
    const test = harness();
    const created = await test.service.send(sendParams());

    const error = await expectAppError(
      test.service.remove({
        channelId: TEST_CHANNEL_ID,
        messageId: created.message.message_id,
        claims: buildClaims({ userId: OTHER_USER_ID }),
        traceParent: TRACE_PARENT,
      }),
    );

    expect(error.code).toBe("not_message_author");
    expect(test.repository.records.get(created.message.message_id)?.deletedAt).toBeNull();
  });

  it("answers 404 on a repeated delete", async () => {
    const test = harness();
    const created = await test.service.send(sendParams());
    const params = {
      channelId: TEST_CHANNEL_ID,
      messageId: created.message.message_id,
      claims: buildClaims(),
      traceParent: TRACE_PARENT,
    };

    await test.service.remove(params);
    const error = await expectAppError(test.service.remove(params));

    expect(error.code).toBe("message_not_found");
    expect(error.httpStatus).toBe(404);
  });

  it("answers 404 for unknown messages", async () => {
    const test = harness();

    const error = await expectAppError(
      test.service.remove({
        channelId: TEST_CHANNEL_ID,
        messageId: "01JD8W4FQ9Z2X7K3M5A0B1CDEZ",
        claims: buildClaims(),
        traceParent: TRACE_PARENT,
      }),
    );

    expect(error.code).toBe("message_not_found");
  });
});

describe("MessageService — community id propagation", () => {
  it("stores the community id reported by community_service", async () => {
    const test = harness();
    test.access.setDecision(buildAccessDecision({ communityId: "community-99" }));

    const result = await test.service.send(sendParams());

    expect(result.message.community_id).toBe("community-99");
    expect(test.repository.records.get(result.message.message_id)?.communityId).toBe("community-99");
  });

  it("keeps the id type brand intact for stored rows", async () => {
    const test = harness();
    const result = await test.service.send(sendParams());

    expect(test.repository.records.get(asMessageId(result.message.message_id))?.id as string).toBe(result.message.message_id);
    expect(buildMessageRecord().id as string).toBe("01JD8W4FQ9Z2X7K3M5A0B1CDEF");
  });
});
