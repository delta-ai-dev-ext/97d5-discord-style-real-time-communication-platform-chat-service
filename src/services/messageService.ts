import { assertCanReadHistory, assertCanSend } from "../access/decision";
import type { AccessClient, AccessDecision } from "../access/types";
import type { SessionClaims } from "../auth/types";
import { internalError, isAppError, messageNotFound, notMessageAuthor, rateLimited } from "../errors";
import {
  buildEnvelope,
  buildOutboxEntry,
  messageCreatedData,
  messageDeletedData,
  messageEditedData,
} from "../events/envelope";
import type { AppLogger } from "../logger";
import type { Metrics } from "../metrics";
import { asMessageId, generateEventId as defaultGenerateEventId, generateMessageId, isMessageId } from "../models/ids";
import type { MessageId } from "../models/ids";
import { parseEditMessageBody, parseSendMessageBody, toMessageDto } from "../models/message";
import type { MessageDto, MessageListResponse, MessageRecord } from "../models/message";
import { parseListQuery } from "../models/pagination";
import type { RateLimiter } from "../rateLimit";
import type { MessageRepository, OutboxEntry } from "../repositories/types";

/**
 * Domain rules for text channel messages: nonce idempotency, author-only
 * mutation and cursor pagination semantics. No HTTP or persistence decisions
 * live here.
 */

export interface MessageServiceDeps {
  repository: MessageRepository;
  accessClient: AccessClient;
  rateLimiter: RateLimiter;
  metrics: Metrics;
  logger: AppLogger;
  now?: () => Date;
  generateId?: (nowMs: number) => string;
  generateEventId?: () => string;
}

export interface SendMessageParams {
  channelId: string;
  claims: SessionClaims;
  body: unknown;
  traceParent: string;
}

export interface SendMessageResult {
  status: 200 | 201;
  message: MessageDto;
}

export interface ListMessagesParams {
  channelId: string;
  claims: SessionClaims;
  query: Record<string, unknown>;
  traceParent: string;
}

export interface EditMessageParams {
  channelId: string;
  messageId: string;
  claims: SessionClaims;
  body: unknown;
  traceParent: string;
}

export interface DeleteMessageParams {
  channelId: string;
  messageId: string;
  claims: SessionClaims;
  traceParent: string;
}

export class MessageService {
  private readonly repository: MessageRepository;
  private readonly accessClient: AccessClient;
  private readonly rateLimiter: RateLimiter;
  private readonly metrics: Metrics;
  private readonly logger: AppLogger;
  private readonly now: () => Date;
  private readonly generateId: (nowMs: number) => string;
  private readonly generateEventId: () => string;

  constructor(deps: MessageServiceDeps) {
    this.repository = deps.repository;
    this.accessClient = deps.accessClient;
    this.rateLimiter = deps.rateLimiter;
    this.metrics = deps.metrics;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? generateMessageId;
    this.generateEventId = deps.generateEventId ?? defaultGenerateEventId;
  }

  async send(params: SendMessageParams): Promise<SendMessageResult> {
    let body;

    try {
      body = parseSendMessageBody(params.body);
    } catch (error) {
      this.metrics.recordSendRejection("validation");
      throw error;
    }

    this.enforceRateLimit(params.claims.userId);

    const decision = await this.checkAccess(params.channelId, params.claims.userId, params.traceParent);

    try {
      assertCanSend(decision, this.now());
    } catch (error) {
      if (isAppError(error)) {
        if (error.code === "member_timed_out") {
          this.metrics.recordSendRejection("timed_out");
        } else if (error.code === "missing_permission") {
          this.metrics.recordSendRejection("missing_permission");
        }
      }

      throw error;
    }

    const createdAt = this.now();
    const record: MessageRecord = {
      id: asMessageId(this.generateId(createdAt.getTime())),
      channelId: params.channelId,
      communityId: decision.communityId,
      authorUserId: params.claims.userId,
      authorUsername: params.claims.username,
      content: body.content,
      clientNonce: body.client_nonce,
      createdAt,
      editedAt: null,
      deletedAt: null,
    };
    const event = this.buildEvent({
      eventType: "message_created",
      data: messageCreatedData(record),
      channelId: params.channelId,
      occurredAt: createdAt,
      traceParent: params.traceParent,
    });

    let outcome;

    try {
      // Message + outbox event commit together, or not at all (ADR-001).
      outcome = await this.repository.createWithEvent({ message: record, event });
    } catch (error) {
      this.logger.error("message insert failed", {
        operation: "send_message",
        status: "error",
        channel_id: params.channelId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw internalError();
    }

    if (outcome.outcome === "duplicate") {
      this.metrics.recordDeduplicatedSend();
      this.logger.info("client nonce replayed", {
        operation: "send_message",
        status: "deduplicated",
        channel_id: params.channelId,
        message_id: outcome.message.id,
      });

      return { status: 200, message: toMessageDto(outcome.message) };
    }

    this.metrics.recordMessageSent("text");
    this.logger.info("message sent", {
      operation: "send_message",
      status: "created",
      channel_id: params.channelId,
      message_id: outcome.message.id,
    });

    return { status: 201, message: toMessageDto(outcome.message) };
  }

  async list(params: ListMessagesParams): Promise<MessageListResponse> {
    const query = parseListQuery(params.query);
    const decision = await this.checkAccess(params.channelId, params.claims.userId, params.traceParent);

    assertCanReadHistory(decision);

    let rows: MessageRecord[];

    try {
      rows = await this.repository.listHistory({
        channelId: params.channelId,
        limit: query.limit,
        ...(query.before ? { before: query.before } : {}),
        ...(query.after ? { after: query.after } : {}),
      });
    } catch (error) {
      this.logger.error("message history read failed", {
        operation: "list_messages",
        status: "error",
        channel_id: params.channelId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw internalError();
    }

    // A full page means there may be more; the cursor is the page boundary in
    // the paging direction (oldest for `before`, newest for `after`).
    const boundary = rows.length === query.limit ? rows[rows.length - 1] : undefined;

    return {
      messages: rows.map(toMessageDto),
      next_cursor: boundary ? boundary.id : null,
    };
  }

  async edit(params: EditMessageParams): Promise<MessageDto> {
    const body = parseEditMessageBody(params.body);
    const record = await this.requireOwnedMessage(params.channelId, params.messageId, params.claims.userId, "edit");

    const editedAt = this.now();
    const updated: MessageRecord = { ...record, content: body.content, editedAt };
    const event = this.buildEvent({
      eventType: "message_edited",
      data: messageEditedData(updated),
      channelId: params.channelId,
      occurredAt: editedAt,
      traceParent: params.traceParent,
    });

    const result = await this.mutate(() =>
      this.repository.editWithEvent({
        channelId: params.channelId,
        messageId: record.id,
        authorUserId: params.claims.userId,
        content: body.content,
        editedAt,
        event,
      }),
    );

    if (!result) {
      throw messageNotFound();
    }

    this.metrics.recordMessageEdited();
    this.logger.info("message edited", {
      operation: "edit_message",
      status: "updated",
      channel_id: params.channelId,
      message_id: record.id,
    });

    return toMessageDto(result);
  }

  async remove(params: DeleteMessageParams): Promise<void> {
    const record = await this.requireOwnedMessage(params.channelId, params.messageId, params.claims.userId, "delete");

    const deletedAt = this.now();
    const event = this.buildEvent({
      eventType: "message_deleted",
      data: messageDeletedData(record),
      channelId: params.channelId,
      occurredAt: deletedAt,
      traceParent: params.traceParent,
    });

    const deletedRow = await this.mutate(() =>
      this.repository.softDeleteWithEvent({
        channelId: params.channelId,
        messageId: record.id,
        authorUserId: params.claims.userId,
        deletedAt,
        event,
      }),
    );

    if (!deletedRow) {
      throw messageNotFound();
    }

    this.metrics.recordMessageDeleted();
    this.logger.info("message deleted", {
      operation: "delete_message",
      status: "deleted",
      channel_id: params.channelId,
      message_id: record.id,
    });
  }

  /**
   * Edits and deletes are author-scoped, never permission-scoped, so they do
   * not call `community_service` (architecture §2.2).
   */
  private async requireOwnedMessage(
    channelId: string,
    rawMessageId: string,
    userId: string,
    action: "edit" | "delete",
  ): Promise<MessageRecord> {
    if (!isMessageId(rawMessageId)) {
      throw messageNotFound();
    }

    const record = await this.read(() => this.repository.findById(channelId, asMessageId(rawMessageId)));

    if (!record || record.deletedAt !== null) {
      throw messageNotFound();
    }

    if (record.authorUserId !== userId) {
      throw notMessageAuthor(action);
    }

    return record;
  }

  private enforceRateLimit(userId: string): void {
    const decision = this.rateLimiter.consume(userId, this.now().getTime());

    if (!decision.allowed) {
      throw rateLimited();
    }
  }

  private async checkAccess(channelId: string, userId: string, traceParent: string): Promise<AccessDecision> {
    return this.accessClient.checkAccess({ channelId, userId, traceParent });
  }

  private buildEvent(params: {
    eventType: OutboxEntry["eventType"];
    data: Record<string, unknown>;
    channelId: string;
    occurredAt: Date;
    traceParent: string;
  }): OutboxEntry {
    const payload = buildEnvelope({
      eventId: this.generateEventId(),
      eventType: params.eventType,
      occurredAt: params.occurredAt,
      traceParent: params.traceParent.length > 0 ? params.traceParent : null,
      data: params.data,
    });

    return buildOutboxEntry({ payload, partitionKey: params.channelId, createdAt: params.occurredAt });
  }

  private async read<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.logger.error("message store read failed", {
        operation: "message_read",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });

      throw internalError();
    }
  }

  private async mutate<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.logger.error("message store write failed", {
        operation: "message_write",
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });

      throw internalError();
    }
  }
}

export type { MessageId };
