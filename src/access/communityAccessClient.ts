import { z } from "zod";
import { accessUnavailable, channelNotFound, isAppError } from "../errors";
import type { AppLogger } from "../logger";
import type { Metrics } from "../metrics";
import type { AccessCheckRequest, AccessClient, AccessDecision } from "./types";

/**
 * Synchronous access client for `community_service` (ADR-002).
 *
 * - configured timeout (300 ms by default), exactly one retry, then **fail closed**;
 * - the response is untrusted input and is validated before use;
 * - never cached: bans/timeouts must take effect on the very next request.
 */

/**
 * The access contract. Only the text-channel capabilities this service actually
 * consumes are required; the voice capabilities are validated when present.
 */
const accessPayloadSchema = z.object({
  community_id: z.string().min(1),
  channel_type: z.string().min(1),
  is_member: z.boolean(),
  can_view: z.boolean(),
  can_read_history: z.boolean(),
  can_send: z.boolean(),
  can_connect: z.boolean().optional(),
  can_speak: z.boolean().optional(),
  can_video: z.boolean().optional(),
  timed_out_until: z.string().nullable(),
  banned: z.boolean(),
});

export interface CommunityAccessClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  metrics: Metrics;
  logger: AppLogger;
  /** Test seam; defaults to the platform-native `fetch`. */
  fetchImpl?: typeof fetch;
  /** Total attempts including the first one (1 retry ⇒ 2 attempts). */
  maxAttempts?: number;
}

function parseTimeout(value: string | null): Date | null | undefined {
  if (value === null) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toDecision(payload: z.infer<typeof accessPayloadSchema>): AccessDecision | null {
  const timedOutUntil = parseTimeout(payload.timed_out_until);

  if (timedOutUntil === undefined) {
    return null;
  }

  return {
    communityId: payload.community_id,
    channelType: payload.channel_type,
    isMember: payload.is_member,
    canView: payload.can_view,
    canReadHistory: payload.can_read_history,
    canSend: payload.can_send,
    timedOutUntil,
    banned: payload.banned,
  };
}

export function createCommunityAccessClient(options: CommunityAccessClientOptions): AccessClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const endpoint = (channelId: string, userId: string): string =>
    `${options.baseUrl}/internal/v1/channels/${encodeURIComponent(channelId)}/access/${encodeURIComponent(userId)}`;

  async function attempt(request: AccessCheckRequest): Promise<AccessDecision> {
    const startedAt = performance.now();
    const response = await fetchImpl(endpoint(request.channelId, request.userId), {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.serviceToken}`,
        traceparent: request.traceParent,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    options.metrics.observeAccessCheck((performance.now() - startedAt) / 1000);

    if (response.status === 404) {
      throw channelNotFound();
    }

    if (!response.ok) {
      throw new Error(`community_service responded with ${response.status}`);
    }

    const body: unknown = await response.json();
    const parsed = accessPayloadSchema.safeParse(body);

    if (!parsed.success) {
      throw new Error("community_service returned an invalid access payload");
    }

    const decision = toDecision(parsed.data);

    if (!decision) {
      throw new Error("community_service returned an invalid timed_out_until value");
    }

    return decision;
  }

  return {
    async checkAccess(request: AccessCheckRequest): Promise<AccessDecision> {
      let lastError: unknown = null;

      for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
        try {
          return await attempt(request);
        } catch (error) {
          if (isAppError(error)) {
            // An authoritative "channel not found" is not retried.
            throw error;
          }

          lastError = error;
          options.logger.warn("community_service access check failed", {
            operation: "access_check",
            status: "retry",
            attempt: attemptIndex + 1,
            channel_id: request.channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      options.logger.error("community_service access check failed closed", {
        operation: "access_check",
        status: "error",
        channel_id: request.channelId,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });

      throw accessUnavailable();
    },
  };
}
