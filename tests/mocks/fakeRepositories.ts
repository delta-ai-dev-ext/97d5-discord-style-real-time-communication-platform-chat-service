import type {
  CreateMessageInput,
  CreateMessageOutcome,
  DeleteMessageInput,
  EditMessageInput,
  ListHistoryInput,
  MessageRepository,
  OutboxRepository,
  OutboxRow,
  PurgeRepository,
} from "../../src/repositories/types";
import type { MessageId } from "../../src/models/ids";
import type { MessageRecord } from "../../src/models/message";

/**
 * In-memory `MessageRepository` that reproduces the database constraints the
 * service relies on: the unique `(channel_id, author_user_id, client_nonce)`
 * index, soft-delete visibility, and id-ordered history reads.
 */
export class FakeMessageRepository implements MessageRepository {
  readonly records = new Map<string, MessageRecord>();
  /** Outbox rows committed by the repository — used to assert atomicity. */
  readonly events: CreateMessageInput["event"][] = [];
  /** Set to make the next write fail like a database error. */
  failNextWrite: Error | null = null;

  async createWithEvent(input: CreateMessageInput): Promise<CreateMessageOutcome> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }

    const existing = [...this.records.values()].find(
      (record) =>
        record.channelId === input.message.channelId &&
        record.authorUserId === input.message.authorUserId &&
        record.clientNonce === input.message.clientNonce,
    );

    if (existing) {
      return { outcome: "duplicate", message: existing };
    }

    this.records.set(input.message.id, input.message);
    this.events.push(input.event);

    return { outcome: "created", message: input.message };
  }

  async findById(channelId: string, messageId: MessageId): Promise<MessageRecord | null> {
    const record = this.records.get(messageId);

    return record && record.channelId === channelId ? record : null;
  }

  async editWithEvent(input: EditMessageInput): Promise<MessageRecord | null> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }

    const record = this.records.get(input.messageId);

    if (
      !record ||
      record.channelId !== input.channelId ||
      record.authorUserId !== input.authorUserId ||
      record.deletedAt !== null
    ) {
      return null;
    }

    const updated: MessageRecord = { ...record, content: input.content, editedAt: input.editedAt };
    this.records.set(updated.id, updated);
    this.events.push(input.event);

    return updated;
  }

  async softDeleteWithEvent(input: DeleteMessageInput): Promise<boolean> {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = null;
      throw error;
    }

    const record = this.records.get(input.messageId);

    if (
      !record ||
      record.channelId !== input.channelId ||
      record.authorUserId !== input.authorUserId ||
      record.deletedAt !== null
    ) {
      return false;
    }

    this.records.set(record.id, { ...record, deletedAt: input.deletedAt });
    this.events.push(input.event);

    return true;
  }

  async listHistory(input: ListHistoryInput): Promise<MessageRecord[]> {
    const rows = [...this.records.values()].filter(
      (record) =>
        record.channelId === input.channelId &&
        record.deletedAt === null &&
        (input.before === undefined || record.id < input.before) &&
        (input.after === undefined || record.id > input.after),
    );

    rows.sort((left, right) => (input.after ? (left.id < right.id ? -1 : 1) : left.id > right.id ? -1 : 1));

    return rows.slice(0, input.limit);
  }
}

/** In-memory `PurgeRepository` (processed_events ledger + batched hard delete). */
export class InMemoryPurgeRepository implements PurgeRepository {
  readonly processed = new Map<string, Date>();
  readonly records: Map<string, MessageRecord>;
  /** Every batch size requested, so tests can assert bounded batching. */
  readonly purgeCalls: number[] = [];

  constructor(records: Map<string, MessageRecord> = new Map()) {
    this.records = records;
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return this.processed.has(eventId);
  }

  async markEventProcessed(eventId: string): Promise<void> {
    this.processed.set(eventId, new Date());
  }

  async purgeChannelMessages(channelIds: string[], batchSize: number): Promise<number> {
    this.purgeCalls.push(batchSize);
    const targets = [...this.records.values()].filter((record) => channelIds.includes(record.channelId)).slice(0, batchSize);

    for (const target of targets) {
      this.records.delete(target.id);
    }

    return targets.length;
  }
}

/** In-memory `OutboxRepository`. */
export class FakeOutboxRepository implements OutboxRepository {
  readonly rows: OutboxRow[] = [];

  seed(row: OutboxRow): void {
    this.rows.push(row);
  }

  unpublished(): OutboxRow[] {
    return this.rows.filter((row) => row.publishedAt === null);
  }

  async fetchUnpublished(limit: number): Promise<OutboxRow[]> {
    return this.unpublished()
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, limit);
  }

  async markPublished(ids: string[], publishedAt: Date): Promise<void> {
    for (const row of this.rows) {
      if (ids.includes(row.id)) {
        row.publishedAt = publishedAt;
      }
    }
  }

  async oldestUnpublishedCreatedAt(): Promise<Date | null> {
    const oldest = this.unpublished().sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    )[0];

    return oldest ? oldest.createdAt : null;
  }
}
