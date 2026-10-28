import { asc, inArray, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { outboxEvents } from "../db/schema";
import type { OutboxEventRow } from "../db/schema";
import type { OutboxRepository, OutboxRow } from "./types";

function toOutboxRow(row: OutboxEventRow): OutboxRow {
  return {
    id: row.id,
    topic: row.topic,
    eventType: row.eventType as OutboxRow["eventType"],
    partitionKey: row.partitionKey,
    payload: row.payload as OutboxRow["payload"],
    traceParent: row.traceParent,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
  };
}

/**
 * Drizzle implementation of `OutboxRepository`.
 *
 * Dispatch order is `created_at` ascending so per-channel ordering is preserved
 * (ADR-001). Published rows are retained for a bounded window and pruned by
 * scheduled cleanup outside the relay hot path.
 */
export class DrizzleOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Database) {}

  async fetchUnpublished(limit: number): Promise<OutboxRow[]> {
    const rows = await this.db
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit);

    return rows.map(toOutboxRow);
  }

  async markPublished(ids: string[], publishedAt: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db.update(outboxEvents).set({ publishedAt }).where(inArray(outboxEvents.id, ids));
  }

  async oldestUnpublishedCreatedAt(): Promise<Date | null> {
    const rows = await this.db
      .select({ createdAt: outboxEvents.createdAt })
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(1);

    return rows.at(0)?.createdAt ?? null;
  }
}
