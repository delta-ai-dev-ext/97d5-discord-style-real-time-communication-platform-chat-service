import type { AppLogger } from "../logger";
import type { ProcessOutcome } from "./communityEventsProcessor";
import { COMMUNITY_EVENTS_TOPIC } from "./types";
import type { EventConsumer } from "./types";

/**
 * `community_events` subscriber (consumer group `chat_service`).
 *
 * Offsets are committed manually and only after the dedupe record for the event
 * has been persisted, so a crash mid-purge resumes the work on redelivery.
 */

export interface KafkaEachMessagePayloadLike {
  topic: string;
  partition: number;
  message: {
    value: Uint8Array | null;
    offset: string;
  };
}

export interface CommitOffset {
  topic: string;
  partition: number;
  offset: string;
}

/** The subset of the kafkajs consumer this service depends on. */
export interface KafkaConsumerLike {
  connect(): Promise<void>;
  subscribe(subscription: { topics: string[]; fromBeginning?: boolean }): Promise<void>;
  run(config: { eachMessage: (payload: KafkaEachMessagePayloadLike) => Promise<void> }): Promise<void>;
  commitOffsets(offsets: CommitOffset[]): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CommunityEventsConsumerDeps {
  processor: { process(raw: string | null): Promise<ProcessOutcome> };
  consumerFactory: () => KafkaConsumerLike;
  logger: AppLogger;
  topic?: string;
}

export class CommunityEventsConsumer implements EventConsumer {
  private readonly processor: CommunityEventsConsumerDeps["processor"];
  private readonly consumerFactory: () => KafkaConsumerLike;
  private readonly logger: AppLogger;
  private readonly topic: string;

  private consumer: KafkaConsumerLike | null = null;
  private started = false;

  constructor(deps: CommunityEventsConsumerDeps) {
    this.processor = deps.processor;
    this.consumerFactory = deps.consumerFactory;
    this.logger = deps.logger;
    this.topic = deps.topic ?? COMMUNITY_EVENTS_TOPIC;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    const consumer = this.consumerFactory();
    this.consumer = consumer;

    await consumer.connect();
    await consumer.subscribe({ topics: [this.topic], fromBeginning: false });
    await consumer.run({ eachMessage: (payload) => this.handleMessage(payload) });

    this.logger.info("community events consumer started", {
      operation: "community_events",
      status: "started",
      topic: this.topic,
    });
  }

  /** Handles one record: persist first, commit the next offset afterwards. */
  async handleMessage(payload: KafkaEachMessagePayloadLike): Promise<void> {
    const consumer = this.consumer;

    if (!consumer) {
      throw new Error("community events consumer is not running");
    }

    const raw = payload.message.value ? new TextDecoder().decode(payload.message.value) : null;

    try {
      const outcome = await this.processor.process(raw);
      const nextOffset = String(Number(payload.message.offset) + 1);

      await consumer.commitOffsets([
        { topic: payload.topic, partition: payload.partition, offset: nextOffset },
      ]);

      this.logger.info("community event handled", {
        operation: "community_events",
        status: outcome,
        topic: payload.topic,
        partition: payload.partition,
        offset: payload.message.offset,
      });
    } catch (error) {
      // Rethrowing lets kafkajs redeliver the record (at-least-once).
      this.logger.error("community event handling failed", {
        operation: "community_events",
        status: "error",
        topic: payload.topic,
        partition: payload.partition,
        offset: payload.message.offset,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const consumer = this.consumer;
    this.consumer = null;

    if (!consumer) {
      return;
    }

    await consumer.stop();
    await consumer.disconnect();
  }
}
