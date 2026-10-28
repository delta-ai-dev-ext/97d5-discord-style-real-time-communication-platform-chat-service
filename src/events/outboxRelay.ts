import type { AppLogger } from "../logger";
import type { Metrics } from "../metrics";
import type { OutboxRepository, OutboxRow } from "../repositories/types";
import { serializeEnvelope } from "./envelope";
import type { EventProducer } from "./types";

/**
 * Transactional outbox relay (ADR-001).
 *
 * Polls unpublished rows in `created_at` order, publishes them to
 * `chat_message_events` keyed by `channel_id`, and marks them published only
 * after the broker acknowledges. Kafka failures never reach a request: they
 * leave the row unpublished and the relay retries with exponential backoff.
 */

export interface OutboxRelayDeps {
  outbox: OutboxRepository;
  producer: EventProducer;
  metrics: Metrics;
  logger: AppLogger;
  now?: () => Date;
  batchSize?: number;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface TickResult {
  published: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class OutboxRelay {
  private readonly outbox: OutboxRepository;
  private readonly producer: EventProducer;
  private readonly metrics: Metrics;
  private readonly logger: AppLogger;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private delayMs: number;

  constructor(deps: OutboxRelayDeps) {
    this.outbox = deps.outbox;
    this.producer = deps.producer;
    this.metrics = deps.metrics;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.baseBackoffMs = deps.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.delayMs = this.pollIntervalMs;
  }

  get currentDelayMs(): number {
    return this.delayMs;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** One dispatch pass. Never throws: failures stay in the outbox. */
  async tick(): Promise<TickResult> {
    let published = 0;
    let failed = 0;

    try {
      const rows = await this.outbox.fetchUnpublished(this.batchSize);
      this.recordOldestAge(rows);

      const publishedIds: string[] = [];

      for (const row of rows) {
        try {
          await this.publish(row);
          publishedIds.push(row.id);
          published += 1;
        } catch (error) {
          failed += 1;
          this.metrics.recordKafkaProduceError(row.topic);
          this.logger.error("outbox publish failed", {
            operation: "outbox_relay",
            status: "error",
            topic: row.topic,
            event_id: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // Preserve per-channel ordering: never publish later rows ahead of a
          // row that has not been acknowledged yet.
          break;
        }
      }

      if (publishedIds.length > 0) {
        await this.outbox.markPublished(publishedIds, this.now());
      }
    } catch (error) {
      failed += 1;
      this.logger.error("outbox read failed", {
        operation: "outbox_relay",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.updateBackoff(failed);
    this.logger.debug("outbox relay tick", {
      operation: "outbox_relay",
      status: failed > 0 ? "error" : "ok",
      published,
      failed,
    });

    return { published, failed };
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async publish(row: OutboxRow): Promise<void> {
    await this.producer.publish({
      topic: row.topic,
      key: row.partitionKey,
      value: serializeEnvelope(row.payload),
      headers: {
        "content-type": "application/json",
        ...(row.traceParent ? { traceparent: row.traceParent } : {}),
      },
    });
  }

  private recordOldestAge(rows: OutboxRow[]): void {
    const oldest = rows[0];

    if (!oldest) {
      this.metrics.setOutboxUnpublishedAge(0);
      return;
    }

    const ageSeconds = Math.max(0, (this.now().getTime() - oldest.createdAt.getTime()) / 1000);
    this.metrics.setOutboxUnpublishedAge(ageSeconds);
  }

  private updateBackoff(failed: number): void {
    if (failed > 0) {
      this.consecutiveFailures += 1;
      this.delayMs = Math.min(
        this.maxBackoffMs,
        this.baseBackoffMs * 2 ** (this.consecutiveFailures - 1),
      );

      return;
    }

    this.consecutiveFailures = 0;
    this.delayMs = this.pollIntervalMs;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    await this.tick();

    if (!this.running) {
      return;
    }

    this.schedule(this.delayMs);
  }
}
