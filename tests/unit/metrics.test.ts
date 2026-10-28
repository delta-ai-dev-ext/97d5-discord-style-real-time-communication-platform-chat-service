import { describe, expect, it } from "bun:test";
import { Registry } from "prom-client";
import { createMetrics, statusClass } from "../../src/metrics";

describe("createMetrics", () => {
  it("registers every metric required by architecture §7", async () => {
    const metrics = createMetrics(new Registry());
    const exposition = await metrics.registry.metrics();

    for (const name of [
      "chat_messages_sent_total",
      "chat_messages_edited_total",
      "chat_messages_deleted_total",
      "chat_send_rejections_total",
      "chat_send_retries_deduplicated_total",
      "http_request_duration_seconds",
      "chat_access_check_duration_seconds",
      "kafka_produce_errors_total",
      "kafka_consumer_lag",
      "outbox_unpublished_age_seconds",
    ]) {
      expect(exposition).toContain(name);
    }
  });

  it("records business counters with low-cardinality labels only", async () => {
    const metrics = createMetrics(new Registry());

    metrics.recordMessageSent("text");
    metrics.recordMessageEdited();
    metrics.recordMessageDeleted();
    metrics.recordSendRejection("timed_out");
    metrics.recordSendRejection("missing_permission");
    metrics.recordSendRejection("validation");
    metrics.recordDeduplicatedSend();
    metrics.observeAccessCheck(0.05);

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('chat_messages_sent_total{channel_type="text"} 1');
    expect(exposition).toContain('chat_send_rejections_total{reason="timed_out"} 1');
    expect(exposition).toContain('chat_send_rejections_total{reason="missing_permission"} 1');
    expect(exposition).toContain('chat_send_rejections_total{reason="validation"} 1');
    expect(exposition).toContain("chat_send_retries_deduplicated_total 1");
    expect(exposition).toContain("chat_messages_edited_total 1");
    expect(exposition).toContain("chat_messages_deleted_total 1");
    expect(exposition).toContain("chat_access_check_duration_seconds_count 1");
  });

  it("keeps registries independent so tests cannot leak samples", async () => {
    const first = createMetrics(new Registry());
    const second = createMetrics(new Registry());

    first.recordMessageSent("text");

    const secondExposition = await second.registry.metrics();
    expect(secondExposition).not.toContain('chat_messages_sent_total{channel_type="text"} 1');
    expect(secondExposition).toContain("chat_messages_sent_total");
  });

  it("records kafka and outbox health signals", async () => {
    const metrics = createMetrics(new Registry());

    metrics.recordKafkaProduceError("chat_message_events");
    metrics.setConsumerLag("community_events", "chat_service", 12);
    metrics.setOutboxUnpublishedAge(3.5);

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('kafka_produce_errors_total{topic="chat_message_events"} 1');
    expect(exposition).toContain('kafka_consumer_lag{topic="community_events",group="chat_service"} 12');
    expect(exposition).toContain("outbox_unpublished_age_seconds 3.5");
  });

  it("observes HTTP durations per route without high-cardinality labels", async () => {
    const metrics = createMetrics(new Registry());

    metrics.observeHttpRequest({ route: "/v1/channels/:channel_id/messages", method: "POST", status: 201 }, 0.04);

    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('route="/v1/channels/:channel_id/messages"');
    expect(exposition).toContain('method="POST"');
    expect(exposition).toContain('status_class="2xx"');
    expect(exposition).toContain('http_request_duration_seconds_count{route="/v1/channels/:channel_id/messages",method="POST",status_class="2xx"} 1');
  });
});

describe("statusClass", () => {
  it("maps status codes to classes", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(201)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
  });
});
