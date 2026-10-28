import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** `messages` — architecture §4. */
export const messages = pgTable(
  "messages",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    channelId: varchar("channel_id").notNull(),
    communityId: varchar("community_id").notNull(),
    authorUserId: varchar("author_user_id").notNull(),
    authorUsername: varchar("author_username").notNull(),
    content: text("content").notNull(),
    clientNonce: varchar("client_nonce", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Send idempotency: a nonce replay conflicts and returns the original row.
    uniqueIndex("uq_messages_nonce").on(table.channelId, table.authorUserId, table.clientNonce),
    // History pagination and reconnect backfill.
    index("idx_messages_channel_cursor")
      .on(table.channelId, table.id.desc())
      .where(sql`${table.deletedAt} IS NULL`),
    // Community-wide purge.
    index("idx_messages_community").on(table.communityId),
    check("messages_content_length_check", sql`char_length(${table.content}) BETWEEN 1 AND 4000`),
  ],
);

/** `processed_events` — consumer idempotency ledger for `community_events`. */
export const processedEvents = pgTable("processed_events", {
  eventId: uuid("event_id").primaryKey(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `outbox_events` — ADR-001 transactional outbox. */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey(),
    topic: varchar("topic").notNull(),
    eventType: varchar("event_type").notNull(),
    partitionKey: varchar("partition_key").notNull(),
    payload: jsonb("payload").notNull(),
    traceParent: varchar("trace_parent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [index("idx_outbox_unpublished").on(table.createdAt).where(sql`${table.publishedAt} IS NULL`)],
);

export type MessageRow = typeof messages.$inferSelect;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
