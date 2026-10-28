import { describe, expect, it } from "bun:test";
import { AUTHOR_TOKEN, OTHER_TOKEN, createAppHarness } from "../mocks/appHarness";
import { httpCall } from "../mocks/httpClient";

const CHANNEL_PATH = "/v1/channels/channel-1/messages";

interface ErrorBody {
  error: { code: string; message: string };
}

interface MessageBody {
  message_id: string;
  content: string;
  edited_at: string | null;
}

async function createMessage(test: ReturnType<typeof createAppHarness>): Promise<string> {
  const response = await httpCall<MessageBody>(test.app, CHANNEL_PATH, {
    method: "POST",
    token: AUTHOR_TOKEN,
    body: { content: "hello world", client_nonce: "nonce-1" },
  });

  return response.body?.message_id as string;
}

describe("PATCH /v1/channels/{channel_id}/messages/{message_id}", () => {
  it("updates the author's message and sets edited_at", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    const response = await httpCall<MessageBody>(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "hello again" },
    });

    expect(response.status).toBe(200);
    expect(response.body?.content).toBe("hello again");
    expect(response.body?.edited_at).not.toBeNull();
    expect(test.repository.events.map((event) => event.eventType)).toEqual(["message_created", "message_edited"]);
  });

  it("never calls community_service for author-scoped edits", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);
    const callsBefore = test.access.callCount;

    await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "edit" },
    });

    expect(test.access.callCount).toBe(callsBefore);
  });

  it("rejects a non-author with not_message_author", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    const response = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "PATCH",
      token: OTHER_TOKEN,
      body: { content: "hijacked" },
    });

    expect(response.status).toBe(403);
    expect((response.body as unknown as ErrorBody).error.code).toBe("not_message_author");
    expect(test.repository.records.get(messageId)?.content).toBe("hello world");
  });

  it("answers 404 for unknown messages and 422 for invalid content", async () => {
    const test = createAppHarness();

    const unknown = await httpCall(test.app, `${CHANNEL_PATH}/01JD8W4FQ9Z2X7K3M5A0B1CDEZ`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "x" },
    });
    const malformed = await httpCall(test.app, `${CHANNEL_PATH}/not-a-cursor`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "x" },
    });
    const messageId = await createMessage(test);
    const invalid = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "   " },
    });

    expect(unknown.status).toBe(404);
    expect((unknown.body as unknown as ErrorBody).error.code).toBe("message_not_found");
    expect(malformed.status).toBe(404);
    expect(invalid.status).toBe(422);
    expect((invalid.body as unknown as ErrorBody).error.code).toBe("validation_error");
  });

  it("refuses to edit a deleted message with 404", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, { method: "DELETE", token: AUTHOR_TOKEN });
    const response = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "too late" },
    });

    expect(response.status).toBe(404);
  });
});

describe("DELETE /v1/channels/{channel_id}/messages/{message_id}", () => {
  it("soft-deletes the author's message and answers 204", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);
    const callsBefore = test.access.callCount;

    const response = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "DELETE",
      token: AUTHOR_TOKEN,
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(test.repository.records.get(messageId)?.deletedAt).not.toBeNull();
    expect(test.access.callCount).toBe(callsBefore);
    expect(test.repository.events.map((event) => event.eventType)).toEqual(["message_created", "message_deleted"]);
  });

  it("hides the deleted message from history", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, { method: "DELETE", token: AUTHOR_TOKEN });
    const history = await httpCall<{ messages: MessageBody[] }>(test.app, CHANNEL_PATH, { token: AUTHOR_TOKEN });

    expect(history.body?.messages).toHaveLength(0);
  });

  it("rejects a non-author with 403", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    const response = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "DELETE",
      token: OTHER_TOKEN,
    });

    expect(response.status).toBe(403);
    expect((response.body as unknown as ErrorBody).error.code).toBe("not_message_author");
    expect(test.repository.records.get(messageId)?.deletedAt).toBeNull();
  });

  it("answers 404 on a repeated delete", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    const first = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, { method: "DELETE", token: AUTHOR_TOKEN });
    const second = await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, { method: "DELETE", token: AUTHOR_TOKEN });

    expect(first.status).toBe(204);
    expect(second.status).toBe(404);
    expect((second.body as unknown as ErrorBody).error.code).toBe("message_not_found");
  });

  it("records the edit and delete business metrics", async () => {
    const test = createAppHarness();
    const messageId = await createMessage(test);

    await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, {
      method: "PATCH",
      token: AUTHOR_TOKEN,
      body: { content: "edited" },
    });
    await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, { method: "DELETE", token: AUTHOR_TOKEN });
    await httpCall(test.app, `${CHANNEL_PATH}/${messageId}`, { method: "DELETE", token: AUTHOR_TOKEN });

    const metrics = await test.metrics.registry.metrics();
    expect(metrics).toContain("chat_messages_edited_total 1");
    expect(metrics).toContain("chat_messages_deleted_total 1");
  });
});
