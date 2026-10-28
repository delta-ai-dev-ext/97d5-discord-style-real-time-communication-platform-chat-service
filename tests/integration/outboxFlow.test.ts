import { describe, expect, it } from "bun:test";
import { Registry } from "prom-client";
import { OutboxRelay } from "../../src/events/outboxRelay";
import { createLogger } from "../../src/logger";
import { createMetrics } from "../../src/metrics";
import { AUTHOR_TOKEN, createAppHarness } from "../mocks/appHarness";
import { FakeEventProducer } from "../mocks/fakeKafka";
import { FakeOutboxRepository } from "../mocks/fakeRepositories";
import { httpCall } from "../mocks/httpClient";

const CHANNEL_PATH = "/v1/channels/channel-1/messages";
const TRACE_PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("HTTP send → outbox → Kafka (ADR-001)", () => {
  it("publishes exactly one message_created event per persisted message", async () => {
    const test = createAppHarness();

    const created = await httpCall<{ message_id: string }>(test.app, CHANNEL_PATH, {
      method: "POST",
      token: AUTHOR_TOKEN,
      body: { content: "hello world", client_nonce: "nonce-1" },
      headers: { traceparent: TRACE_PARENT },
    });

    // The outbox rows committed by the send transaction drive the relay.
    const outbox = new FakeOutboxRepository();
    for (const entry of test.repository.events) {
      outbox.seed({ ...entry, publishedAt: null });
    }

    const producer = new FakeEventProducer();
    await producer.connect();
    const metrics = createMetrics(new Registry());
    const relay = new OutboxRelay({
      outbox,
      producer,
      metrics,
      logger: createLogger({ level: "error", sink: () => undefined }),
    });

    const result = await relay.tick();

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(producer.published).toHaveLength(1);
    const record = producer.published[0];
    expect(record?.topic).toBe("chat_message_events");
    expect(record?.key).toBe("channel-1");
    expect(record?.headers?.traceparent).toBe(TRACE_PARENT);

    const envelope = JSON.parse(record?.value ?? "{}") as {
      event_type: string;
      producer: string;
      version: string;
      trace_parent: string;
      data: Record<string, unknown>;
    };
    expect(envelope.event_type).toBe("message_created");
    expect(envelope.producer).toBe("chat_service");
    expect(envelope.version).toBe("1");
    expect(envelope.trace_parent).toBe(TRACE_PARENT);
    expect(envelope.data).toMatchObject({
      message_id: created.body?.message_id,
      channel_id: "channel-1",
      community_id: "community-1",
      author_user_id: "user_author",
      author_username: "author",
      content: "hello world",
      client_nonce: "nonce-1",
    });
    expect(outbox.unpublished()).toHaveLength(0);
  });

  it("does not publish a second event when a send is replayed", async () => {
    const test = createAppHarness();
    const body = { content: "hello world", client_nonce: "nonce-1" };

    await httpCall(test.app, CHANNEL_PATH, { method: "POST", token: AUTHOR_TOKEN, body });
    await httpCall(test.app, CHANNEL_PATH, { method: "POST", token: AUTHOR_TOKEN, body });

    expect(test.repository.events).toHaveLength(1);
  });
});
