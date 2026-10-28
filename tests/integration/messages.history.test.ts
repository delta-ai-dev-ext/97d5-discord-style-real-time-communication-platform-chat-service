import { describe, expect, it } from "bun:test";
import { accessUnavailable } from "../../src/errors";
import { AUTHOR_TOKEN, createAppHarness } from "../mocks/appHarness";
import { buildAccessDecision } from "../mocks/builders";
import { httpCall } from "../mocks/httpClient";

const CHANNEL_PATH = "/v1/channels/channel-1/messages";

interface ErrorBody {
  error: { code: string; message: string };
}

interface ListBody {
  messages: Array<{ message_id: string; content: string }>;
  next_cursor: string | null;
}

async function seed(test: ReturnType<typeof createAppHarness>, count: number): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const response = await httpCall(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: `message ${index}`, client_nonce: `nonce-${index}` },
    });
    ids.push((response.body as { message_id: string }).message_id);
  }

  return ids;
}

describe("GET /v1/channels/{channel_id}/messages", () => {
  it("returns the newest page first with a cursor for older messages", async () => {
    const test = createAppHarness();
    const ids = await seed(test, 3);

    const page = await httpCall<ListBody>(test.app, `${CHANNEL_PATH}?limit=2`, { token: AUTHOR_TOKEN });

    expect(page.status).toBe(200);
    expect(page.body?.messages.map((message) => message.message_id)).toEqual([ids[2] as string, ids[1] as string]);
    expect(page.body?.next_cursor).toBe(ids[1] as string);
  });

  it("returns a null cursor when the beginning of history is reached", async () => {
    const test = createAppHarness();
    await seed(test, 2);

    const page = await httpCall<ListBody>(test.app, CHANNEL_PATH, { token: AUTHOR_TOKEN });

    expect(page.status).toBe(200);
    expect(page.body?.messages).toHaveLength(2);
    expect(page.body?.next_cursor).toBeNull();
  });

  it("pages strictly older messages with before", async () => {
    const test = createAppHarness();
    const ids = await seed(test, 4);

    const page = await httpCall<ListBody>(test.app, `${CHANNEL_PATH}?limit=2&before=${ids[2]}`, {
      token: AUTHOR_TOKEN,
    });

    expect(page.body?.messages.map((message) => message.message_id)).toEqual([ids[1] as string, ids[0] as string]);
  });

  it("backfills strictly newer messages oldest-first with after (US-006)", async () => {
    const test = createAppHarness();
    const ids = await seed(test, 4);

    const page = await httpCall<ListBody>(test.app, `${CHANNEL_PATH}?after=${ids[0]}&limit=2`, {
      token: AUTHOR_TOKEN,
    });

    expect(page.body?.messages.map((message) => message.message_id)).toEqual([ids[1] as string, ids[2] as string]);
    expect(page.body?.next_cursor).toBe(ids[2] as string);
  });

  it("returns an empty page for an empty channel", async () => {
    const test = createAppHarness();

    const page = await httpCall<ListBody>(test.app, CHANNEL_PATH, { token: AUTHOR_TOKEN });

    expect(page.status).toBe(200);
    expect(page.body).toEqual({ messages: [], next_cursor: null });
  });

  it("rejects out-of-range limits and malformed cursors with 400", async () => {
    const test = createAppHarness();

    const tooLarge = await httpCall(test.app, `${CHANNEL_PATH}?limit=101`, { token: AUTHOR_TOKEN });
    const tooSmall = await httpCall(test.app, `${CHANNEL_PATH}?limit=0`, { token: AUTHOR_TOKEN });
    const notANumber = await httpCall(test.app, `${CHANNEL_PATH}?limit=abc`, { token: AUTHOR_TOKEN });
    const badCursor = await httpCall(test.app, `${CHANNEL_PATH}?before=not-a-cursor`, { token: AUTHOR_TOKEN });
    const both = await httpCall(test.app, `${CHANNEL_PATH}?before=01JD8W4FQ9Z2X7K3M5A0B1CDEF&after=01JD8W4FQ9Z2X7K3M5A0B1CDEG`, {
      token: AUTHOR_TOKEN,
    });

    for (const response of [tooLarge, tooSmall, notANumber, both]) {
      expect(response.status).toBe(400);
      expect((response.body as unknown as ErrorBody).error.code).toBe("validation_error");
    }

    expect(badCursor.status).toBe(400);
    expect((badCursor.body as unknown as ErrorBody).error.code).toBe("invalid_cursor");
  });

  it("checks VIEW_CHANNEL and READ_MESSAGE_HISTORY on every read (US-009)", async () => {
    const test = createAppHarness();

    for (const decision of [
      buildAccessDecision({ canView: false }),
      buildAccessDecision({ canReadHistory: false }),
    ]) {
      test.access.setDecision(decision);
      const response = await httpCall(test.app, CHANNEL_PATH, { token: AUTHOR_TOKEN });

      expect(response.status).toBe(403);
      expect((response.body as unknown as ErrorBody).error.code).toBe("missing_permission");
    }

    expect(test.access.callCount).toBe(2);
  });

  it("lets a timed-out member read history (US-008)", async () => {
    const test = createAppHarness();
    await seed(test, 1);
    test.access.setDecision(buildAccessDecision({ timedOutUntil: new Date("2030-01-01T00:00:00.000Z") }));

    const response = await httpCall<ListBody>(test.app, CHANNEL_PATH, { token: AUTHOR_TOKEN });

    expect(response.status).toBe(200);
    expect(response.body?.messages).toHaveLength(1);
  });

  it("fails closed with 503 when the access check cannot complete", async () => {
    const test = createAppHarness();
    test.access.setError(accessUnavailable());

    const response = await httpCall(test.app, CHANNEL_PATH, { token: AUTHOR_TOKEN });

    expect(response.status).toBe(503);
    expect((response.body as unknown as ErrorBody).error.code).toBe("access_unavailable");
  });

  it("requires a session token", async () => {
    const test = createAppHarness();

    const response = await httpCall(test.app, CHANNEL_PATH);

    expect(response.status).toBe(401);
  });
});
