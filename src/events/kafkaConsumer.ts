import type { Admin } from "kafkajs";
import type { Config } from "../config";
import type { AppLogger } from "../logger";
import type { Metrics } from "../metrics";
import type { CommitOffset, KafkaConsumerLike } from "./communityEventsConsumer";
import { createKafkaClient } from "./kafkaProducer";
import { COMMUNITY_EVENTS_TOPIC } from "./types";

/**
 * kafkajs consumer factory: `community_events`, consumer group `chat_service`,
 * manual offset commits (the offset is committed by the consumer only after the
 * dedupe record is persisted).
 */
export function createKafkaConsumerFactory(config: Config): () => KafkaConsumerLike {
  const kafka = createKafkaClient(config);

  return () => {
    const consumer = kafka.consumer({ groupId: config.kafka.consumerGroup });

    return {
      connect: () => consumer.connect(),
      subscribe: (subscription) => consumer.subscribe(subscription),
      run: (runConfig) =>
        consumer.run({ autoCommit: false, eachMessage: runConfig.eachMessage }),
      commitOffsets: (offsets: CommitOffset[]) => consumer.commitOffsets(offsets),
      stop: () => consumer.stop(),
      disconnect: () => consumer.disconnect(),
    };
  };
}

export interface LagMonitorOptions {
  config: Config;
  metrics: Metrics;
  logger: AppLogger;
  intervalMs?: number;
}

/**
 * Publishes `kafka_consumer_lag{topic,group}` by comparing topic head offsets
 * with the group's committed offsets.
 */
export function startLagMonitor(options: LagMonitorOptions): () => void {
  const admin: Admin = createKafkaClient(options.config).admin();
  const group = options.config.kafka.consumerGroup;
  let stopped = false;

  const sample = async (): Promise<void> => {
    try {
      const [topicOffsets, groupOffsets] = await Promise.all([
        admin.fetchTopicOffsets(COMMUNITY_EVENTS_TOPIC),
        admin.fetchOffsets({ groupId: group, topics: [COMMUNITY_EVENTS_TOPIC] }),
      ]);
      const committed = new Map<number, number>();

      for (const topic of groupOffsets) {
        for (const partition of topic.partitions) {
          committed.set(partition.partition, Number(partition.offset));
        }
      }

      let lag = 0;

      for (const partition of topicOffsets) {
        const offset = committed.get(partition.partition);

        if (offset !== undefined && offset >= 0) {
          lag += Math.max(0, Number(partition.high) - offset);
        }
      }

      options.metrics.setConsumerLag(COMMUNITY_EVENTS_TOPIC, group, lag);
    } catch (error) {
      options.logger.warn("kafka lag sample failed", {
        operation: "lag_monitor",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const timer = setInterval(() => {
    if (!stopped) {
      void sample();
    }
  }, options.intervalMs ?? 30_000);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    void admin.disconnect().catch(() => undefined);
  };
}
