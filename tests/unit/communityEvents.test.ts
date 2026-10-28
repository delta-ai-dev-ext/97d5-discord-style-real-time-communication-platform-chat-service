import { describe, expect, it } from "bun:test";
import { CommunityEventsProcessor } from "../../src/events/communityEventsProcessor";
import { createLogger } from "../../src/logger";
import { buildMessageRecord } from "../mocks/builders";
import { InMemoryPurgeRepository } from "../mocks/fakeRepositories";
import type { MessageRecord } from "../../src/models/message";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function envelope(eventType: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: EVENT_ID,
    event_type: eventType,
    occurred_at: "2025-01-01T12:00:00.000Z",
    producer: "community_service",
    version: "1",
    trace_parent: null,
    data,
    ...overrides,
  });
}

function harness(options: { batchSize?: number; records?: MessageRecord[] } = {}) {
  const records = new Map<string, MessageRecord>();

  for (const record of options.records ?? []) {
    records.set(record.id, record);
  }

  const purge = new InMemoryPurgeRepository(records);
  const processor = new CommunityEventsProcessor({
    purge,
    logger: createLogger({ level: "error", sink: () => undefined }),
    batchSize: options.batchSize ?? 100,
  });

  return { processor, purge, records };
}

function seedMessages(count: number, channelId: string, prefix: string): MessageRecord[] {
  return Array.from({ length: count }, (_unused, index) =>
    buildMessageRecord({
      id: `${prefix}${String(index).padStart(10, "0")}` as MessageRecord["id"],
      channelId,
      clientNonce: `${prefix}-nonce-${index}`,
    }),
  );
}

describe("CommunityEventsProcessor — channel_deleted (US-010)", () => {
  it("hard-deletes every message of a text channel", async () => {
    const test = harness({ records: seedMessages(3, "channel-1", "01JD8W4FQ9") });

    const outcome = await test.processor.process(
      envelope("channel_deleted", { community_id: "community-1", channel_id: "channel-1", type: "text" }),
    );

    expect(outcome).toBe("processed");
    expect(test.records.size).toBe(0);
    expect(test.purge.processed.has(EVENT_ID)).toBe(true);
  });

  it("ignores non-text channels but still marks the event processed", async () => {
    const test = harness({ records: seedMessages(2, "channel-1", "01JD8W4FQ9") });

    const outcome = await test.processor.process(
      envelope("channel_deleted", { community_id: "community-1", channel_id: "channel-1", type: "voice" }),
    );

    expect(outcome).toBe("noop");
    expect(test.records.size).toBe(2);
    expect(test.purge.processed.has(EVENT_ID)).toBe(true);
  });
});

describe("CommunityEventsProcessor — community_deleted (US-010)", () => {
  it("purges every listed channel in bounded batches", async () => {
    const test = harness({
      batchSize: 2,
      records: [...seedMessages(3, "channel-1", "01JD8W4FQ9"), ...seedMessages(2, "channel-2", "01JD8W4FQ9")],
    });

    const outcome = await test.processor.process(
      envelope("community_deleted", { community_id: "community-1", channel_ids: ["channel-1", "channel-2"] }),
    );

    expect(outcome).toBe("processed");
    expect(test.records.size).toBe(0);
    expect(test.purge.purgeCalls.every((size) => size === 2)).toBe(true);
    expect(test.purge.purgeCalls.length).toBeGreaterThan(1);
  });

  it("treats an empty channel list as a processed no-op", async () => {
    const test = harness();

    const outcome = await test.processor.process(
      envelope("community_deleted", { community_id: "community-1", channel_ids: [] }),
    );

    expect(outcome).toBe("noop");
    expect(test.purge.processed.has(EVENT_ID)).toBe(true);
  });
});

describe("CommunityEventsProcessor — idempotency", () => {
  it("does no work when the same event_id is delivered twice", async () => {
    const test = harness({ records: seedMessages(2, "channel-1", "01JD8W4FQ9") });
    const payload = envelope("channel_deleted", {
      community_id: "community-1",
      channel_id: "channel-1",
      type: "text",
    });

    const first = await test.processor.process(payload);
    const second = await test.processor.process(payload);

    expect(first).toBe("processed");
    expect(second).toBe("deduplicated");
    expect(test.purge.purgeCalls).toHaveLength(1);
  });

  it("ignores unrelated event types but records them as processed", async () => {
    const test = harness({ records: seedMessages(1, "channel-1", "01JD8W4FQ9") });

    const outcome = await test.processor.process(
      envelope("member_joined", { community_id: "community-1", user_id: "user-1" }),
    );

    expect(outcome).toBe("noop");
    expect(test.records.size).toBe(1);
    expect(test.purge.processed.has(EVENT_ID)).toBe(true);
  });

  it("acknowledges malformed or unparseable payloads without throwing", async () => {
    const test = harness({ records: seedMessages(1, "channel-1", "01JD8W4FQ9") });

    expect(await test.processor.process("not-json")).toBe("ignored");
    expect(await test.processor.process(null)).toBe("ignored");
    expect(await test.processor.process("")).toBe("ignored");
    expect(await test.processor.process(JSON.stringify({ event_type: "channel_deleted" }))).toBe("ignored");
    expect(
      await test.processor.process(
        envelope("channel_deleted", { community_id: "community-1", channel_id: 42, type: "text" }),
      ),
    ).toBe("ignored");
    expect(await test.processor.process(envelope("community_deleted", { community_id: "community-1" }))).toBe(
      "ignored",
    );
    expect(test.records.size).toBe(1);
  });

  it("does not mark an unparseable payload as processed", async () => {
    const test = harness();

    await test.processor.process("not-json");

    expect(test.purge.processed.size).toBe(0);
  });
});
