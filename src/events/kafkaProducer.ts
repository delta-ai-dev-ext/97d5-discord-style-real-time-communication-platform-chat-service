import { Kafka, logLevel } from "kafkajs";
import type { SASLOptions } from "kafkajs";
import type { Config, KafkaSaslConfig } from "../config";
import type { EventProducer, PublishRecord } from "./types";

/** kafkajs models SASL as a discriminated union, so narrow per mechanism. */
function toSaslOptions(sasl: KafkaSaslConfig | undefined): SASLOptions | undefined {
  if (!sasl) {
    return undefined;
  }

  switch (sasl.mechanism) {
    case "plain":
      return { mechanism: "plain", username: sasl.username, password: sasl.password };
    case "scram-sha-256":
      return { mechanism: "scram-sha-256", username: sasl.username, password: sasl.password };
    case "scram-sha-512":
      return { mechanism: "scram-sha-512", username: sasl.username, password: sasl.password };
  }
}

/** kafkajs adapter (platform-standard client, per Pinned Decisions). */
export function createKafkaClient(config: Config): Kafka {
  const sasl = toSaslOptions(config.kafka.sasl);

  return new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    ...(config.kafka.tls ? { ssl: true } : {}),
    ...(sasl ? { sasl } : {}),
    logLevel: logLevel.NOTHING,
  });
}

export function createKafkaProducer(config: Config): EventProducer {
  const producer = createKafkaClient(config).producer({ allowAutoTopicCreation: false });
  let connected = false;

  return {
    async connect(): Promise<void> {
      await producer.connect();
      connected = true;
    },
    async disconnect(): Promise<void> {
      connected = false;
      await producer.disconnect();
    },
    isConnected(): boolean {
      return connected;
    },
    async publish(record: PublishRecord): Promise<void> {
      await producer.send({
        topic: record.topic,
        messages: [{ key: record.key, value: record.value, headers: record.headers }],
      });
    },
  };
}
