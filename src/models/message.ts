import { z } from "zod";
import { validationFailed } from "../errors";
import type { MessageId } from "./ids";

/** Max characters per message (architecture §4 check constraint). */
export const MAX_CONTENT_LENGTH = 4000;
export const MAX_CLIENT_NONCE_LENGTH = 64;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** A row of the `messages` table. */
export interface MessageRecord {
  id: MessageId;
  channelId: string;
  communityId: string;
  authorUserId: string;
  authorUsername: string;
  content: string;
  clientNonce: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/** The `Message` schema from `docs/openapi_spec.yaml`. */
export interface MessageDto {
  message_id: string;
  channel_id: string;
  community_id: string;
  author_user_id: string;
  author_username: string;
  content: string;
  client_nonce: string;
  created_at: string;
  edited_at: string | null;
}

export interface MessageListResponse {
  messages: MessageDto[];
  next_cursor: string | null;
}

export function toMessageDto(record: MessageRecord): MessageDto {
  return {
    message_id: record.id,
    channel_id: record.channelId,
    community_id: record.communityId,
    author_user_id: record.authorUserId,
    author_username: record.authorUsername,
    content: record.content,
    client_nonce: record.clientNonce,
    created_at: record.createdAt.toISOString(),
    edited_at: record.editedAt ? record.editedAt.toISOString() : null,
  };
}

const contentSchema = z
  .string({ message: "Message content must be a string" })
  .refine((content) => content.length <= MAX_CONTENT_LENGTH, {
    message: `Message content must be between 1 and ${MAX_CONTENT_LENGTH} characters`,
  })
  .refine((content) => content.trim().length >= 1, {
    message: `Message content must be between 1 and ${MAX_CONTENT_LENGTH} characters`,
  });

export const sendMessageBodySchema = z.object({
  content: contentSchema,
  client_nonce: z
    .string({ message: "client_nonce is required" })
    .min(1, { message: "client_nonce must be between 1 and 64 characters" })
    .max(MAX_CLIENT_NONCE_LENGTH, { message: "client_nonce must be between 1 and 64 characters" }),
});

export const editMessageBodySchema = z.object({
  content: contentSchema,
});

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
export type EditMessageBody = z.infer<typeof editMessageBodySchema>;

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "The request body is invalid";
}

/** Parses the send body or throws a `422 validation_error`. */
export function parseSendMessageBody(body: unknown): SendMessageBody {
  const parsed = sendMessageBodySchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed(firstIssueMessage(parsed.error));
  }

  return parsed.data;
}

/** Parses the edit body or throws a `422 validation_error`. */
export function parseEditMessageBody(body: unknown): EditMessageBody {
  const parsed = editMessageBodySchema.safeParse(body);

  if (!parsed.success) {
    throw validationFailed(firstIssueMessage(parsed.error));
  }

  return parsed.data;
}
