import { describe, expect, it } from "bun:test";
import {
  CommunityEventsConsumer,
  type KafkaConsumerLike,
  type KafkaEachMessagePayloadLike,
} from "../../src/events/communityEventsConsumer";
import type { ProcessOutcome } from "../../src/events/communityEventsProcessor";
import { createLogger } from "../../src/logger";

class FakeKafkaConsumer implements KafkaConsumerLike {
  readonly subscriptions: Array<{ topics: string[]; fromBeginning?: boolean }> = [];
  readonly committed: Array<Array<{ topic: string; partition: number; offset: string }>> = [];
  eachMessage: ((payload: KafkaEachMessagePayloadLike) => Promise<void>) | null = null;
  connectCalls = 0;
  stopCalls = 0;
  disconnectCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async subscribe(subscription: { topics: string[]; fromBeginning?: boolean }): Promise<void> {
    this.subscriptions.push(subscription);
  }

  async run(config: { eachMessage: (payload: KafkaEachMessagePayloadLike) => Promise<void> }): Promise<void> {
    this.eachMessage = config.eachMessage;
  }

  async commitOffsets(offsets: Array<{ topic: string; partition: number; offset: string }>): Promise<void> {
    this.committed.push(offsets);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
}

function harness(processImpl: (raw: string | null) => Promise<ProcessOutcome>) {
  const consumer = new FakeKafkaConsumer();
  const seen: Array<string | null> = [];
  const sut = new CommunityEventsConsumer({
    processor: {
      process: async (raw) => {
        seen.push(raw);

        return processImpl(raw);
      },
    },
    consumerFactory: () => consumer,
    logger: createLogger({ level: "error", sink: () => undefined }),
  });

  return { sut, consumer, seen };
}

const payload = (offset: string): KafkaEachMessagePayloadLike => ({
  topic: "community_events",
  partition: 2,
  message: { value: new TextEncoder().encode('{"event_id":"x"}'), offset },
});

describe("CommunityEventsConsumer", () => {
  it("subscribes to community_events and starts the loop with manual commits", async () => {
    const test = harness(async () => "processed");

    await test.sut.start();

    expect(test.consumer.connectCalls).toBe(1);
    expect(test.consumer.subscriptions).toEqual([{ topics: ["community_events"], fromBeginning: false }]);
    expect(test.consumer.eachMessage).not.toBeNull();
  });

  it("commits the next offset only after the event is persisted", async () => {
    const test = harness(async () => "processed");
    await test.sut.start();

    await test.sut.handleMessage(payload("41"));

    expect(test.seen).toEqual(['{"event_id":"x"}']);
    expect(test.consumer.committed).toEqual([[{ topic: "community_events", partition: 2, offset: "42" }]]);
  });

  it("does not commit when processing fails, so Kafka redelivers", async () => {
    const test = harness(async () => {
      throw new Error("database unavailable");
    });
    await test.sut.start();

    await expect(test.sut.handleMessage(payload("7"))).rejects.toThrow("database unavailable");
    expect(test.consumer.committed).toEqual([]);
  });

  it("handles a tombstone message without skipping the commit", async () => {
    const test = harness(async () => "ignored");
    await test.sut.start();

    await test.sut.handleMessage({ topic: "community_events", partition: 0, message: { value: null, offset: "3" } });

    expect(test.seen).toEqual([null]);
    expect(test.consumer.committed).toHaveLength(1);
  });

  it("rejects messages when the consumer is not running", async () => {
    const test = harness(async () => "processed");

    await expect(test.sut.handleMessage(payload("1"))).rejects.toThrow("not running");
  });

  it("stops and disconnects on shutdown", async () => {
    const test = harness(async () => "processed");
    await test.sut.start();

    await test.sut.stop();

    expect(test.consumer.stopCalls).toBe(1);
    expect(test.consumer.disconnectCalls).toBe(1);
  });

  it("is safe to stop before it started", async () => {
    const test = harness(async () => "processed");

    await expect(test.sut.stop()).resolves.toBeUndefined();
    expect(test.consumer.stopCalls).toBe(0);
  });
});
