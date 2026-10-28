import { z } from "zod";
import type { AppLogger } from "../logger";
import type { PurgeRepository } from "../repositories/types";

/**
 * `community_events` handler (architecture §3.2).
 *
 * Delivery is at-least-once, so every event is deduplicated on `event_id`
 * through the `processed_events` ledger. Purging is idempotent and runs in
 * bounded batches, so a crash mid-purge simply resumes on redelivery.
 *
 * Ordering choice: the ledger row is written *after* the purge completes. A
 * crash between the two re-runs an idempotent delete rather than losing work,
 * and the consumer only commits the Kafka offset once this method resolves.
 */

export type ProcessOutcome = "processed" | "deduplicated" | "noop" | "ignored";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const envelopeSchema = z.object({
  event_id: z.string().regex(UUID_PATTERN),
  event_type: z.string().min(1),
  data: z.unknown().optional(),
});

const channelDeletedSchema = z.object({
  community_id: z.string().min(1),
  channel_id: z.string().min(1),
  type: z.string().min(1),
});

const communityDeletedSchema = z.object({
  community_id: z.string().min(1),
  channel_ids: z.array(z.string().min(1)),
});

export interface CommunityEventsProcessorDeps {
  purge: PurgeRepository;
  logger: AppLogger;
  /** Rows deleted per statement; bounds a large community deletion. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 500;

export class CommunityEventsProcessor {
  private readonly purge: PurgeRepository;
  private readonly logger: AppLogger;
  private readonly batchSize: number;

  constructor(deps: CommunityEventsProcessorDeps) {
    this.purge = deps.purge;
    this.logger = deps.logger;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async process(raw: string | null): Promise<ProcessOutcome> {
    if (raw === null || raw.trim().length === 0) {
      return "ignored";
    }

    let payload: unknown;

    try {
      payload = JSON.parse(raw);
    } catch {
      this.logger.warn("community event is not valid JSON", {
        operation: "community_events",
        status: "ignored",
      });

      return "ignored";
    }

    const envelope = envelopeSchema.safeParse(payload);

    if (!envelope.success) {
      this.logger.warn("community event envelope is invalid", {
        operation: "community_events",
        status: "ignored",
      });

      return "ignored";
    }

    const eventId = envelope.data.event_id;

    switch (envelope.data.event_type) {
      case "channel_deleted":
        return this.handleChannelDeleted(eventId, envelope.data.data);

      case "community_deleted":
        return this.handleCommunityDeleted(eventId, envelope.data.data);

      default:
        // Acknowledged and recorded, but no work is required.
        if (await this.purge.isEventProcessed(eventId)) {
          return "deduplicated";
        }

        await this.purge.markEventProcessed(eventId);

        return "noop";
    }
  }

  private async handleChannelDeleted(eventId: string, data: unknown): Promise<ProcessOutcome> {
    const parsed = channelDeletedSchema.safeParse(data);

    if (!parsed.success) {
      await this.recordPoisonEvent(eventId, "channel_deleted");
      return "ignored";
    }

    if (await this.purge.isEventProcessed(eventId)) {
      return "deduplicated";
    }

    if (parsed.data.type !== "text") {
      await this.purge.markEventProcessed(eventId);

      return "noop";
    }

    const deleted = await this.purgeInBatches([parsed.data.channel_id]);
    await this.purge.markEventProcessed(eventId);
    this.logger.info("channel history purged", {
      operation: "community_events",
      status: "processed",
      event_type: "channel_deleted",
      channel_id: parsed.data.channel_id,
      deleted,
    });

    return "processed";
  }

  private async handleCommunityDeleted(eventId: string, data: unknown): Promise<ProcessOutcome> {
    const parsed = communityDeletedSchema.safeParse(data);

    if (!parsed.success) {
      await this.recordPoisonEvent(eventId, "community_deleted");
      return "ignored";
    }

    if (await this.purge.isEventProcessed(eventId)) {
      return "deduplicated";
    }

    if (parsed.data.channel_ids.length === 0) {
      await this.purge.markEventProcessed(eventId);

      return "noop";
    }

    const deleted = await this.purgeInBatches(parsed.data.channel_ids);
    await this.purge.markEventProcessed(eventId);
    this.logger.info("community history purged", {
      operation: "community_events",
      status: "processed",
      event_type: "community_deleted",
      channel_count: parsed.data.channel_ids.length,
      deleted,
    });

    return "processed";
  }

  private async purgeInBatches(channelIds: string[]): Promise<number> {
    let total = 0;

    for (;;) {
      const deleted = await this.purge.purgeChannelMessages(channelIds, this.batchSize);
      total += deleted;

      if (deleted < this.batchSize) {
        return total;
      }
    }
  }

  /**
   * A structurally invalid handled event can never succeed, so it is recorded
   * (to avoid an endless redelivery loop) and reported.
   */
  private async recordPoisonEvent(eventId: string, eventType: string): Promise<void> {
    this.logger.error("community event payload is invalid", {
      operation: "community_events",
      status: "ignored",
      event_type: eventType,
      event_id: eventId,
    });
    await this.purge.markEventProcessed(eventId);
  }
}
