import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import { messages, outboxEvents } from "../db/schema";
import type { MessageRow } from "../db/schema";
import { asMessageId } from "../models/ids";
import type { MessageId } from "../models/ids";
import type { MessageRecord } from "../models/message";
import type {
  CreateMessageInput,
  CreateMessageOutcome,
  DeleteMessageInput,
  EditMessageInput,
  ListHistoryInput,
  MessageRepository,
  OutboxEntry,
} from "./types";

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: asMessageId(row.id),
    channelId: row.channelId,
    communityId: row.communityId,
    authorUserId: row.authorUserId,
    authorUsername: row.authorUsername,
    content: row.content,
    clientNonce: row.clientNonce,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

function toOutboxRow(entry: OutboxEntry): typeof outboxEvents.$inferInsert {
  return {
    id: entry.id,
    topic: entry.topic,
    eventType: entry.eventType,
    partitionKey: entry.partitionKey,
    payload: entry.payload,
    traceParent: entry.traceParent,
    createdAt: entry.createdAt,
  };
}

/**
 * Drizzle implementation of `MessageRepository`.
 *
 * Every mutation writes the message row and its outbox row in one transaction,
 * which is what makes a persisted message always yield exactly one event
 * (ADR-001).
 */
export class DrizzleMessageRepository implements MessageRepository {
  constructor(private readonly db: Database) {}

  async createWithEvent(input: CreateMessageInput): Promise<CreateMessageOutcome> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(messages)
        .values({
          id: input.message.id,
          channelId: input.message.channelId,
          communityId: input.message.communityId,
          authorUserId: input.message.authorUserId,
          authorUsername: input.message.authorUsername,
          content: input.message.content,
          clientNonce: input.message.clientNonce,
          createdAt: input.message.createdAt,
        })
        // unique (channel_id, author_user_id, client_nonce): a replay conflicts
        // and the original row is returned instead of a duplicate.
        .onConflictDoNothing({
          target: [messages.channelId, messages.authorUserId, messages.clientNonce],
        })
        .returning();

      const row = inserted.at(0);

      if (!row) {
        const existing = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.channelId, input.message.channelId),
              eq(messages.authorUserId, input.message.authorUserId),
              eq(messages.clientNonce, input.message.clientNonce),
            ),
          )
          .limit(1);
        const original = existing.at(0);

        if (!original) {
          throw new Error("nonce conflict without a stored message");
        }

        return { outcome: "duplicate", message: toRecord(original) };
      }

      await tx.insert(outboxEvents).values(toOutboxRow(input.event));

      return { outcome: "created", message: toRecord(row) };
    });
  }

  async findById(channelId: string, messageId: MessageId): Promise<MessageRecord | null> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.id, messageId)))
      .limit(1);
    const row = rows.at(0);

    return row ? toRecord(row) : null;
  }

  async editWithEvent(input: EditMessageInput): Promise<MessageRecord | null> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(messages)
        .set({ content: input.content, editedAt: input.editedAt })
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.channelId, input.channelId),
            eq(messages.authorUserId, input.authorUserId),
            isNull(messages.deletedAt),
          ),
        )
        .returning();
      const row = updated.at(0);

      if (!row) {
        return null;
      }

      await tx.insert(outboxEvents).values(toOutboxRow(input.event));

      return toRecord(row);
    });
  }

  async softDeleteWithEvent(input: DeleteMessageInput): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(messages)
        .set({ deletedAt: input.deletedAt })
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.channelId, input.channelId),
            eq(messages.authorUserId, input.authorUserId),
            isNull(messages.deletedAt),
          ),
        )
        .returning({ id: messages.id });

      if (updated.length === 0) {
        return false;
      }

      await tx.insert(outboxEvents).values(toOutboxRow(input.event));

      return true;
    });
  }

  async listHistory(input: ListHistoryInput): Promise<MessageRecord[]> {
    const filters = [eq(messages.channelId, input.channelId), isNull(messages.deletedAt)];

    if (input.before) {
      filters.push(lt(messages.id, input.before));
    }

    if (input.after) {
      filters.push(gt(messages.id, input.after));
    }

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...filters))
      // `before`/default page backwards from the head; `after` walks forward
      // for reconnect backfill.
      .orderBy(input.after ? asc(messages.id) : desc(messages.id))
      .limit(input.limit);

    return rows.map(toRecord);
  }
}
