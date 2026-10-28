import { describe, expect, it } from "bun:test";
import { Registry } from "prom-client";
import { createCommunityAccessClient } from "../../src/access/communityAccessClient";
import type { AccessClient } from "../../src/access/types";
import { AppError } from "../../src/errors";
import { createLogger } from "../../src/logger";
import { createMetrics } from "../../src/metrics";
import type { Metrics } from "../../src/metrics";
import { TEST_CHANNEL_ID, AUTHOR_ID } from "../mocks/builders";
import { FetchStub, hangingResponder, jsonResponse } from "../mocks/fetchStub";
import type { FetchResponder } from "../mocks/fetchStub";

const TRACE_PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function accessPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    community_id: "community-1",
    channel_type: "text",
    is_member: true,
    can_view: true,
    can_read_history: true,
    can_send: true,
    can_connect: false,
    can_speak: false,
    can_video: false,
    timed_out_until: null,
    banned: false,
    ...overrides,
  };
}

interface Harness {
  client: AccessClient;
  fetchStub: FetchStub;
  metrics: Metrics;
}

function harness(responder: FetchResponder, timeoutMs = 300): Harness {
  const fetchStub = new FetchStub(responder);
  const metrics = createMetrics(new Registry());
  const client = createCommunityAccessClient({
    baseUrl: "http://community-service:3001",
    serviceToken: "service-token",
    timeoutMs,
    metrics,
    logger: createLogger({ level: "error", sink: () => undefined }),
    fetchImpl: fetchStub.fetch,
  });

  return { client, fetchStub, metrics };
}

async function expectRejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error("expected the access check to fail");
}

describe("CommunityAccessClient", () => {
  it("calls the internal access endpoint with service auth and trace propagation", async () => {
    const { client, fetchStub } = harness(() => jsonResponse(accessPayload()));

    await client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT });

    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call?.url).toBe(
      `http://community-service:3001/internal/v1/channels/${TEST_CHANNEL_ID}/access/${AUTHOR_ID}`,
    );
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer service-token");
    expect(headers.get("traceparent")).toBe(TRACE_PARENT);
  });

  it("maps the untrusted payload onto a typed decision", async () => {
    const { client } = harness(() =>
      jsonResponse(
        accessPayload({
          channel_type: "text",
          can_send: false,
          is_member: true,
          timed_out_until: "2025-01-01T12:30:00.000Z",
        }),
      ),
    );

    const decision = await client.checkAccess({
      channelId: TEST_CHANNEL_ID,
      userId: AUTHOR_ID,
      traceParent: TRACE_PARENT,
    });

    expect(decision).toEqual({
      communityId: "community-1",
      channelType: "text",
      isMember: true,
      canView: true,
      canReadHistory: true,
      canSend: false,
      timedOutUntil: new Date("2025-01-01T12:30:00.000Z"),
      banned: false,
    });
  });

  it("retries once after a transient 5xx and succeeds", async () => {
    let attempt = 0;
    const { client, fetchStub } = harness(() => {
      attempt += 1;

      return attempt === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse(accessPayload());
    });

    const decision = await client.checkAccess({
      channelId: TEST_CHANNEL_ID,
      userId: AUTHOR_ID,
      traceParent: TRACE_PARENT,
    });

    expect(decision.isMember).toBe(true);
    expect(fetchStub.calls).toHaveLength(2);
  });

  it("retries once after a network error and succeeds", async () => {
    let attempt = 0;
    const { client, fetchStub } = harness(() => {
      attempt += 1;

      if (attempt === 1) {
        throw new TypeError("fetch failed");
      }

      return jsonResponse(accessPayload());
    });

    await client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT });

    expect(fetchStub.calls).toHaveLength(2);
  });

  it("fails closed with 503 access_unavailable when every attempt fails", async () => {
    const { client, fetchStub } = harness(() => jsonResponse({ error: "boom" }, 500));

    const error = await expectRejection(
      client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT }),
    );

    expect(error.code).toBe("access_unavailable");
    expect(error.httpStatus).toBe(503);
    expect(fetchStub.calls).toHaveLength(2);
  });

  it("fails closed when the dependency exceeds the timeout budget", async () => {
    const { client, fetchStub } = harness(hangingResponder(), 5);

    const error = await expectRejection(
      client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT }),
    );

    expect(error.code).toBe("access_unavailable");
    expect(fetchStub.calls).toHaveLength(2);
  });

  it("fails closed when the response shape is not the access contract", async () => {
    const { client, fetchStub } = harness(() => jsonResponse({ can_send: "yes", is_member: true }));

    const error = await expectRejection(
      client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT }),
    );

    expect(error.code).toBe("access_unavailable");
    expect(fetchStub.calls).toHaveLength(2);
  });

  it("rejects a payload with an unparseable timeout timestamp", async () => {
    const { client } = harness(() => jsonResponse(accessPayload({ timed_out_until: "not-a-date" })));

    const error = await expectRejection(
      client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT }),
    );

    expect(error.code).toBe("access_unavailable");
  });

  it("maps an unknown channel to 404 without retrying", async () => {
    const { client, fetchStub } = harness(() => jsonResponse({ error: { code: "channel_not_found" } }, 404));

    const error = await expectRejection(
      client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT }),
    );

    expect(error.code).toBe("channel_not_found");
    expect(error.httpStatus).toBe(404);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("records the access-check duration histogram", async () => {
    const { client, metrics } = harness(() => jsonResponse(accessPayload()));

    await client.checkAccess({ channelId: TEST_CHANNEL_ID, userId: AUTHOR_ID, traceParent: TRACE_PARENT });

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain("chat_access_check_duration_seconds_count 1");
  });

  it("passes banned/non-member payloads through to the decision guards", async () => {
    const { client } = harness(() => jsonResponse(accessPayload({ banned: true, is_member: false })));

    const decision = await client.checkAccess({
      channelId: TEST_CHANNEL_ID,
      userId: AUTHOR_ID,
      traceParent: TRACE_PARENT,
    });

    expect(decision.banned).toBe(true);
    expect(decision.isMember).toBe(false);
  });
});
