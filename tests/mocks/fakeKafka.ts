import type { EventConsumer, EventProducer, PublishRecord } from "../../src/events/types";

/** Records published records and can be told to fail. */
export class FakeEventProducer implements EventProducer {
  readonly published: PublishRecord[] = [];
  /** Number of upcoming publishes that should throw (-1 = always). */
  failuresRemaining = 0;
  connectCalls = 0;
  disconnectCalls = 0;
  private connected = false;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(record: PublishRecord): Promise<void> {
    if (this.failuresRemaining !== 0) {
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
      }

      throw new Error("kafka produce failed");
    }

    if (!this.connected) {
      throw new Error("producer is not connected");
    }

    this.published.push(record);
  }
}

/** No-op consumer double. */
export class FakeEventConsumer implements EventConsumer {
  startCalls = 0;
  stopCalls = 0;

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}
