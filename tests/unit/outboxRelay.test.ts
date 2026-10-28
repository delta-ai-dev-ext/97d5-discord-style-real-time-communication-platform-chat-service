import { describe, expect, it } from "bun:test";
import { Registry } from "prom-client";
import { OutboxRelay } from "../../src/events/outboxRelay";
import { createLogger } from "../../src/logger";
import { createMetrics } from "../../src/metrics";
import type { Metrics } from "../../src/metrics";
import type { OutboxRepository } from "../../src/repositories/types";
import { TEST_CHANNEL_ID, buildOutboxEntry } from "../mocks/builders";
import { FakeEventProducer } from "../mocks/fakeKafka";
import { FakeOutboxRepository } from "../mocks/fakeRepositories";

interface Harness {
  relay: OutboxRelay;
  outbox: FakeOutboxRepository;
  producer: FakeEventProducer;
  metrics: Metrics;
}

function harness(overrides: { outbox?: OutboxRepository; batchSize?: number; pollIntervalMs?: number } = {}): Harness {
  const outbox = new FakeOutboxRepository();
  const producer = new FakeEventProducer();
  const metrics = createMetrics(new Registry());
  const relay = new OutboxRelay({
    outbox: overrides.outbox ?? outbox,
    producer,
    metrics,
    logger: createLogger({ level: "error", sink: () => undefined }),
    batchSize: overrides.batchSize ?? 10,
    pollIntervalMs: overrides.pollIntervalMs ?? 250,
    baseBackoffMs: 250,
    maxBackoffMs: 2_000,
  });

  return { relay, outbox, producer, metrics };
}

const TRACE_PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("OutboxRelay.tick (ADR-001)", () => {
  it("publishes unpublished rows keyed by channel and marks them published", async () => {
    const test = harness();
    await test.producer.connect();
    test.outbox.seed({
      ...buildOutboxEntry({ payload: buildOutboxEntry().payload }),
      publishedAt: null,
    });

    const result = await test.relay.tick();

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(test.producer.published).toHaveLength(1);
    const record = test.producer.published[0];
    expect(record?.topic).toBe("chat_message_events");
    expect(record?.key).toBe(TEST_CHANNEL_ID);
    const envelope = JSON.parse(record?.value ?? "{}") as Record<string, unknown>;
    expect(envelope).toMatchObject({
      event_id: "8f14e45f-ceea-4a11-8a11-2b1cd0e5a111",
      event_type: "message_created",
      producer: "chat_service",
      version: "1",
      trace_parent: TRACE_PARENT,
    });
    expect(test.outbox.unpublished()).toHaveLength(0);
  });

  it("publishes rows in created_at order, preserving per-channel ordering", async () => {
    const test = harness();
    await test.producer.connect();
    test.outbox.seed({
      ...buildOutboxEntry({ id: "11111111-1111-4111-8111-111111111111", createdAt: new Date("2025-01-01T12:00:02.000Z") }),
      publishedAt: null,
    });
    test.outbox.seed({
      ...buildOutboxEntry({ id: "22222222-2222-4222-8222-222222222222", createdAt: new Date("2025-01-01T12:00:01.000Z") }),
      publishedAt: null,
    });

    await test.relay.tick();

    expect(test.producer.published.map((record) => JSON.parse(record.value).event_id)).toEqual([
      "8f14e45f-ceea-4a11-8a11-2b1cd0e5a111",
      "8f14e45f-ceea-4a11-8a11-2b1cd0e5a111",
    ]);
    expect(test.outbox.unpublished()).toHaveLength(0);
  });

  it("respects the batch size", async () => {
    const test = harness({ batchSize: 1 });
    await test.producer.connect();
    test.outbox.seed({ ...buildOutboxEntry({ id: "11111111-1111-4111-8111-111111111111" }), publishedAt: null });
    test.outbox.seed({ ...buildOutboxEntry({ id: "22222222-2222-4222-8222-222222222222" }), publishedAt: null });

    await test.relay.tick();

    expect(test.producer.published).toHaveLength(1);
    expect(test.outbox.unpublished()).toHaveLength(1);
  });

  it("leaves the row unpublished and counts the error when Kafka fails", async () => {
    const test = harness();
    await test.producer.connect();
    test.producer.failuresRemaining = 1;
    test.outbox.seed({ ...buildOutboxEntry() , publishedAt: null });

    const result = await test.relay.tick();

    expect(result).toEqual({ published: 0, failed: 1 });
    expect(test.outbox.unpublished()).toHaveLength(1);

    const exposition = await test.metrics.registry.metrics();
    expect(exposition).toContain('kafka_produce_errors_total{topic="chat_message_events"} 1');
  });

  it("retries the failed row on the next tick and keeps later rows behind it", async () => {
    const test = harness();
    await test.producer.connect();
    test.producer.failuresRemaining = 1;
    test.outbox.seed({
      ...buildOutboxEntry({ id: "11111111-1111-4111-8111-111111111111", createdAt: new Date("2025-01-01T12:00:01.000Z") }),
      publishedAt: null,
    });
    test.outbox.seed({
      ...buildOutboxEntry({ id: "22222222-2222-4222-8222-222222222222", createdAt: new Date("2025-01-01T12:00:02.000Z") }),
      publishedAt: null,
    });

    await test.relay.tick();
    expect(test.outbox.unpublished()).toHaveLength(2);

    const retry = await test.relay.tick();

    expect(retry).toEqual({ published: 2, failed: 0 });
    expect(test.outbox.unpublished()).toHaveLength(0);
  });

  it("grows the polling delay while failing and resets it on success", async () => {
    const test = harness({ pollIntervalMs: 100 });
    await test.producer.connect();
    test.producer.failuresRemaining = -1;
    test.outbox.seed({ ...buildOutboxEntry(), publishedAt: null });

    await test.relay.tick();
    const firstDelay = test.relay.currentDelayMs;
    await test.relay.tick();
    const secondDelay = test.relay.currentDelayMs;

    expect(firstDelay).toBeGreaterThan(100);
    expect(secondDelay).toBeGreaterThan(firstDelay);
    expect(secondDelay).toBeLessThanOrEqual(2_000);

    test.producer.failuresRemaining = 0;
    await test.relay.tick();

    expect(test.relay.currentDelayMs).toBe(100);
  });

  it("exposes the age of the oldest unpublished row", async () => {
    const test = harness();
    await test.producer.connect();
    test.outbox.seed({
      ...buildOutboxEntry({ createdAt: new Date(Date.now() - 30_000) }),
      publishedAt: null,
    });

    await test.relay.tick();

    const exposition = await test.metrics.registry.metrics();
    const match = /outbox_unpublished_age_seconds (\d+(?:\.\d+)?)/.exec(exposition);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(29);
  });

  it("never throws when the outbox store is unavailable", async () => {
    const failing: OutboxRepository = {
      fetchUnpublished: async () => {
        throw new Error("db down");
      },
      markPublished: async () => undefined,
      oldestUnpublishedCreatedAt: async () => null,
    };
    const test = harness({ outbox: failing });

    const result = await test.relay.tick();

    expect(result).toEqual({ published: 0, failed: 1 });
  });

  it("starts and stops its polling loop", async () => {
    const test = harness({ pollIntervalMs: 5 });
    await test.producer.connect();
    test.outbox.seed({ ...buildOutboxEntry(), publishedAt: null });

    test.relay.start();
    expect(test.relay.isRunning()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await test.relay.stop();

    expect(test.relay.isRunning()).toBe(false);
    expect(test.outbox.unpublished()).toHaveLength(0);
  });
});
