/** Kafka producer used by the outbox relay. */
export interface PublishRecord {
  topic: string;
  /** Partition key — always `channel_id` for `chat_message_events`. */
  key: string;
  /** Serialized event envelope. */
  value: string;
  headers?: Record<string, string>;
}

export interface EventProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  publish(record: PublishRecord): Promise<void>;
}

/** A long-running Kafka consumer loop (the `community_events` subscriber). */
export interface EventConsumer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const CHAT_MESSAGE_EVENTS_TOPIC = "chat_message_events";
export const COMMUNITY_EVENTS_TOPIC = "community_events";
