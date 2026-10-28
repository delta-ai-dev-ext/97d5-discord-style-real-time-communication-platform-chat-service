/**
 * Single typed error used across the service. Controllers map it onto the
 * `{ error: { code, message, details? } }` envelope from
 * `docs/openapi_spec.yaml`; internal details and stack traces never leak.
 */

export type AppErrorCode =
  | "unauthorized"
  | "missing_permission"
  | "member_timed_out"
  | "not_message_author"
  | "channel_not_found"
  | "message_not_found"
  | "validation_error"
  | "invalid_cursor"
  | "rate_limited"
  | "access_unavailable"
  | "internal_error";

export interface ErrorEnvelope {
  error: {
    code: AppErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const unauthorized = (): AppError => new AppError("unauthorized", 401, "A valid session token is required");

export const missingPermission = (
  message = "You do not have permission to perform this action in this channel",
): AppError => new AppError("missing_permission", 403, message);

export const memberTimedOut = (until: Date): AppError =>
  new AppError("member_timed_out", 403, "You are timed out in this channel", {
    timed_out_until: until.toISOString(),
  });

export const notMessageAuthor = (action: "edit" | "delete"): AppError =>
  new AppError("not_message_author", 403, `Only the author can ${action} this message`);

export const channelNotFound = (): AppError => new AppError("channel_not_found", 404, "Channel not found");

export const messageNotFound = (): AppError => new AppError("message_not_found", 404, "Message not found");

/** Semantic body failure: `422` per the OpenAPI contract. */
export const validationFailed = (message: string): AppError => new AppError("validation_error", 422, message);

/** Malformed query parameter: `400` per the OpenAPI contract. */
export const badRequest = (message: string): AppError => new AppError("validation_error", 400, message);

export const invalidCursor = (): AppError =>
  new AppError("invalid_cursor", 400, "The provided cursor is not a valid message id");

export const rateLimited = (): AppError =>
  new AppError("rate_limited", 429, "You are sending messages too quickly, please slow down");

export const accessUnavailable = (): AppError =>
  new AppError("access_unavailable", 503, "Message service is temporarily unavailable, please retry");

export const internalError = (): AppError => new AppError("internal_error", 500, "An unexpected error occurred");

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
