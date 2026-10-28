import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Metrics required by `docs/architecture.md` §7.
 *
 * Labels are deliberately low-cardinality: never `user_id`, `community_id`,
 * `channel_id` or `request_id`.
 */

const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export type SendRejectionReason = "timed_out" | "missing_permission" | "validation";

export type ChannelType = "text" | "voice" | "category" | "unknown";

export interface HttpObservation {
  route: string;
  method: string;
  status: number;
}

export interface Metrics {
  registry: Registry;
  recordMessageSent(channelType: ChannelType): void;
  recordMessageEdited(): void;
  recordMessageDeleted(): void;
  recordSendRejection(reason: SendRejectionReason): void;
  recordDeduplicatedSend(): void;
  observeAccessCheck(durationSeconds: number): void;
  observeHttpRequest(observation: HttpObservation, durationSeconds: number): void;
  recordKafkaProduceError(topic: string): void;
  setConsumerLag(topic: string, group: string, lag: number): void;
  setOutboxUnpublishedAge(ageSeconds: number): void;
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function createMetrics(registry: Registry = new Registry()): Metrics {
  const registers = [registry];

  const chatMessagesSentTotal = new Counter({
    name: "chat_messages_sent_total",
    help: "Messages persisted in a channel, by channel type.",
    labelNames: ["channel_type"] as const,
    registers,
  });

  const chatMessagesEditedTotal = new Counter({
    name: "chat_messages_edited_total",
    help: "Messages edited by their author.",
    registers,
  });

  const chatMessagesDeletedTotal = new Counter({
    name: "chat_messages_deleted_total",
    help: "Messages soft-deleted by their author.",
    registers,
  });

  const chatSendRejectionsTotal = new Counter({
    name: "chat_send_rejections_total",
    help: "Message sends rejected before persistence, by reason.",
    labelNames: ["reason"] as const,
    registers,
  });

  const chatSendRetriesDeduplicatedTotal = new Counter({
    name: "chat_send_retries_deduplicated_total",
    help: "Sends answered from the original row because the client nonce replayed.",
    registers,
  });

  const httpRequestDurationSeconds = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["route", "method", "status_class"] as const,
    buckets: DURATION_BUCKETS_SECONDS,
    registers,
  });

  const chatAccessCheckDurationSeconds = new Histogram({
    name: "chat_access_check_duration_seconds",
    help: "Duration of a community_service access-check round trip in seconds.",
    buckets: DURATION_BUCKETS_SECONDS,
    registers,
  });

  const kafkaProduceErrorsTotal = new Counter({
    name: "kafka_produce_errors_total",
    help: "Kafka produce failures, by topic.",
    labelNames: ["topic"] as const,
    registers,
  });

  const kafkaConsumerLag = new Gauge({
    name: "kafka_consumer_lag",
    help: "Consumer lag (messages behind the head) for the consumer group.",
    labelNames: ["topic", "group"] as const,
    registers,
  });

  const outboxUnpublishedAgeSeconds = new Gauge({
    name: "outbox_unpublished_age_seconds",
    help: "Age in seconds of the oldest unpublished outbox row.",
    registers,
  });

  return {
    registry,
    recordMessageSent(channelType) {
      chatMessagesSentTotal.inc({ channel_type: channelType });
    },
    recordMessageEdited() {
      chatMessagesEditedTotal.inc();
    },
    recordMessageDeleted() {
      chatMessagesDeletedTotal.inc();
    },
    recordSendRejection(reason) {
      chatSendRejectionsTotal.inc({ reason });
    },
    recordDeduplicatedSend() {
      chatSendRetriesDeduplicatedTotal.inc();
    },
    observeAccessCheck(durationSeconds) {
      chatAccessCheckDurationSeconds.observe(durationSeconds);
    },
    observeHttpRequest(observation, durationSeconds) {
      httpRequestDurationSeconds.observe(
        {
          route: observation.route,
          method: observation.method,
          status_class: statusClass(observation.status),
        },
        durationSeconds,
      );
    },
    recordKafkaProduceError(topic) {
      kafkaProduceErrorsTotal.inc({ topic });
    },
    setConsumerLag(topic, group, lag) {
      kafkaConsumerLag.set({ topic, group }, lag);
    },
    setOutboxUnpublishedAge(ageSeconds) {
      outboxUnpublishedAgeSeconds.set(ageSeconds);
    },
  };
}
