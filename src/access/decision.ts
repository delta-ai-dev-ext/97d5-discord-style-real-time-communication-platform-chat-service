import { channelNotFound, memberTimedOut, missingPermission } from "../errors";
import type { AccessDecision } from "./types";

/**
 * Maps a `community_service` access decision onto this service's error
 * contract. `chat_service` computes no permissions itself — it only
 * interprets the authoritative decision.
 */

function isTimedOut(decision: AccessDecision, now: Date): boolean {
  return decision.timedOutUntil !== null && decision.timedOutUntil.getTime() > now.getTime();
}

/** Sending requires a text channel, membership, no ban and `can_send`. */
export function assertCanSend(decision: AccessDecision, now: Date = new Date()): void {
  if (decision.channelType !== "text") {
    throw channelNotFound();
  }

  if (!decision.isMember || decision.banned) {
    throw missingPermission();
  }

  // A timeout is reported to the client with the exact expiry so it can show
  // when posting resumes (US-008).
  if (isTimedOut(decision, now)) {
    throw memberTimedOut(decision.timedOutUntil as Date);
  }

  if (!decision.canSend) {
    throw missingPermission();
  }
}

/**
 * Reading history requires a text channel, membership, no ban and both
 * `can_view` and `can_read_history`. An active timeout never blocks reads.
 */
export function assertCanReadHistory(decision: AccessDecision): void {
  if (decision.channelType !== "text") {
    throw channelNotFound();
  }

  if (!decision.isMember || decision.banned || !decision.canView || !decision.canReadHistory) {
    throw missingPermission();
  }
}
