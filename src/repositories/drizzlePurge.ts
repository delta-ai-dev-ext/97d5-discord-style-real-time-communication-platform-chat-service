import { inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { messages, processedEvents } from "../db/schema";
import type { PurgeRepository } from "./types";

/**
 * Drizzle implementation of the consumer side of `community_events`:
 * the `processed_events` idempotency ledger plus bounded hard deletes.
 */
export class DrizzlePurgeRepository implements PurgeRepository {
  constructor(private readonly db: Database) {}

  async isEventProcessed(eventId: string): Promise<boolean> {
    const rows = await this.db
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(sql`${processedEvents.eventId} = ${eventId}::uuid`)
      .limit(1);

    return rows.length > 0;
  }

  async markEventProcessed(eventId: string): Promise<void> {
    await this.db.insert(processedEvents).values({ eventId }).onConflictDoNothing();
  }

  /**
   * Hard-deletes at most `batchSize` rows of the given channels so a large
   * community deletion cannot stall the consumer or the database.
   */
  async purgeChannelMessages(channelIds: string[], batchSize: number): Promise<number> {
    if (channelIds.length === 0 || batchSize < 1) {
      return 0;
    }

    const deleted = await this.db
      .delete(messages)
      .where(
        inArray(
          messages.id,
          this.db
            .select({ id: messages.id })
            .from(messages)
            .where(inArray(messages.channelId, channelIds))
            .limit(batchSize),
        ),
      )
      .returning({ id: messages.id });

    return deleted.length;
  }
}
