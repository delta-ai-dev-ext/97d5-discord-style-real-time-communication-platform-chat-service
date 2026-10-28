import { describe, expect, it } from "bun:test";
import { accessUnavailable } from "../../src/errors";
import { AUTHOR_TOKEN, createAppHarness } from "../mocks/appHarness";
import { buildAccessDecision } from "../mocks/builders";
import { httpCall } from "../mocks/httpClient";

const CHANNEL_PATH = "/v1/channels/channel-1/messages";
const TRACE_PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe("POST /v1/channels/{channel_id}/messages", () => {
  it("creates a message (201) and persists its outbox event atomically", async () => {
    const test = createAppHarness();

    const response = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hello world", client_nonce: "nonce-1" },
      headers: { traceparent: TRACE_PARENT },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      channel_id: "channel-1",
      community_id: "community-1",
      author_user_id: "user_author",
      author_username: "author",
      content: "hello world",
      client_nonce: "nonce-1",
      edited_at: null,
    });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(test.repository.records.size).toBe(1);
    expect(test.repository.events).toHaveLength(1);
    expect(test.repository.events[0]?.payload.trace_parent).toBe(TRACE_PARENT);
  });

  it("answers 200 with the original message when the client nonce replays", async () => {
    const test = createAppHarness();

    const first = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hello world", client_nonce: "nonce-1" },
    });
    const replay = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "changed content", client_nonce: "nonce-1" },
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ message_id: (first.body as { message_id: string }).message_id });
    expect((replay.body as { content: string }).content).toBe("hello world");
    expect(test.repository.records.size).toBe(1);
    expect(test.repository.events).toHaveLength(1);

    const metrics = await test.metrics.registry.metrics();
    expect(metrics).toContain("chat_send_retries_deduplicated_total 1");
  });

  it("validates the body with 422 and stores nothing", async () => {
    const test = createAppHarness();

    for (const body of [
      { content: "", client_nonce: "n" },
      { content: "   ", client_nonce: "n" },
      { content: "x".repeat(4001), client_nonce: "n" },
      { content: "ok" },
      { content: "ok", client_nonce: "" },
      { content: "ok", client_nonce: "n".repeat(65) },
    ]) {
      const response = await httpCall(test.app, CHANNEL_PATH, { method: "POST", token: AUTHOR_TOKEN, body });

      expect(response.status).toBe(422);
      expect((response.body as unknown as ErrorBody).error.code).toBe("validation_error");
    }

    expect(test.repository.records.size).toBe(0);
    expect(test.access.callCount).toBe(0);
  });

  it("rejects a request without a JSON body without leaking internals", async () => {
    const test = createAppHarness();

    const raw = await test.app.handle(
      new Request("http://chat.local/v1/channels/channel-1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${AUTHOR_TOKEN}`, "content-type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(raw.status).toBeLessThan(500);
    expect(test.repository.records.size).toBe(0);
  });

  it("rejects a timed-out member with member_timed_out and the expiry", async () => {
    const test = createAppHarness();
    test.access.setDecision(buildAccessDecision({ timedOutUntil: new Date("2030-01-01T12:00:00.000Z") }));

    const response = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hi", client_nonce: "n" },
    });

    expect(response.status).toBe(403);
    const error = (response.body as unknown as ErrorBody).error;
    expect(error.code).toBe("member_timed_out");
    expect(error.details).toEqual({ timed_out_until: "2030-01-01T12:00:00.000Z" });
    expect(test.repository.records.size).toBe(0);
  });

  it("rejects a member without SEND_MESSAGES with missing_permission", async () => {
    const test = createAppHarness();
    test.access.setDecision(buildAccessDecision({ canSend: false }));

    const response = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hi", client_nonce: "n" },
    });

    expect(response.status).toBe(403);
    expect((response.body as unknown as ErrorBody).error.code).toBe("missing_permission");
    expect(test.repository.records.size).toBe(0);
  });

  it("answers 404 for a non-text channel", async () => {
    const test = createAppHarness();
    test.access.setDecision(buildAccessDecision({ channelType: "voice" }));

    const voice = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hi", client_nonce: "n" },
    });

    expect(voice.status).toBe(404);
    expect((voice.body as unknown as ErrorBody).error.code).toBe("channel_not_found");
  });

  it("answers 503 access_unavailable when community_service cannot be reached", async () => {
    const test = createAppHarness();
    test.access.setError(accessUnavailable());

    const response = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hi", client_nonce: "n" },
    });

    expect(response.status).toBe(503);
    expect((response.body as unknown as ErrorBody).error.code).toBe("access_unavailable");
    expect(test.repository.records.size).toBe(0);
  });

  it("answers 429 rate_limited once the per-user bucket is empty", async () => {
    const test = createAppHarness({ limitPerMinute: 1 });

    const first = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "one", client_nonce: "n1" },
    });
    const second = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "two", client_nonce: "n2" },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect((second.body as unknown as ErrorBody).error.code).toBe("rate_limited");
  });

  it("answers 401 without a valid session token", async () => {
    const test = createAppHarness();

    const missing = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      body: { content: "hi", client_nonce: "n" },
    });
    const invalid = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: "not-a-session",
      body: { content: "hi", client_nonce: "n" },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect((invalid.body as unknown as ErrorBody).error.code).toBe("unauthorized");
    expect(test.access.callCount).toBe(0);
  });

  it("answers 500 without internals when the database write fails", async () => {
    const test = createAppHarness();
    test.repository.failNextWrite = new Error("connection reset by peer");

    const response = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hi", client_nonce: "n" },
    });

    expect(response.status).toBe(500);
    const error = (response.body as unknown as ErrorBody).error;
    expect(error.code).toBe("internal_error");
    expect(error.message).not.toContain("connection reset");
    expect(test.repository.events).toHaveLength(0);
  });
});
