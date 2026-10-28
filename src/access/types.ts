/**
 * The access-decision contract owned by `community_service`
 * (`GET /internal/v1/channels/{channel_id}/access/{user_id}`).
 *
 * Every field is treated as untrusted input and validated before use.
 */

export interface AccessDecision {
  communityId: string;
  channelType: string;
  isMember: boolean;
  canView: boolean;
  canReadHistory: boolean;
  canSend: boolean;
  timedOutUntil: Date | null;
  banned: boolean;
}

export interface AccessCheckRequest {
  channelId: string;
  userId: string;
  /** W3C traceparent forwarded to `community_service`. */
  traceParent: string;
}

export interface AccessClient {
  /**
   * Resolves the caller's effective access. Throws `AppError`
   * (`channel_not_found` or fail-closed `access_unavailable`) when the
   * decision cannot be obtained.
   */
  checkAccess(request: AccessCheckRequest): Promise<AccessDecision>;
}
