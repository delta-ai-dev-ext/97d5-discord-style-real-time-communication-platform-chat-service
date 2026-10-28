import { describe, expect, it } from "bun:test";
import { assertCanReadHistory, assertCanSend } from "../../src/access/decision";
import { AppError } from "../../src/errors";
import { buildAccessDecision } from "../mocks/builders";

const NOW = new Date("2025-01-01T12:00:00.000Z");

function captureError(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error("expected the guard to throw");
}

describe("assertCanSend (US-001, US-007, US-008)", () => {
  it("allows a member who may post in a text channel", () => {
    expect(() => assertCanSend(buildAccessDecision(), NOW)).not.toThrow();
  });

  it("treats a non-text channel as not found", () => {
    const error = captureError(() => assertCanSend(buildAccessDecision({ channelType: "voice" }), NOW));

    expect(error.code).toBe("channel_not_found");
    expect(error.httpStatus).toBe(404);
  });

  it("rejects non-members and banned users with missing_permission", () => {
    expect(captureError(() => assertCanSend(buildAccessDecision({ isMember: false }), NOW)).code).toBe(
      "missing_permission",
    );
    expect(captureError(() => assertCanSend(buildAccessDecision({ banned: true }), NOW)).code).toBe(
      "missing_permission",
    );
  });

  it("rejects a member without SEND_MESSAGES", () => {
    const error = captureError(() => assertCanSend(buildAccessDecision({ canSend: false }), NOW));

    expect(error.code).toBe("missing_permission");
    expect(error.httpStatus).toBe(403);
  });

  it("reports an active timeout with timed_out_until", () => {
    const timedOutUntil = new Date("2025-01-01T12:30:00.000Z");
    const error = captureError(() => assertCanSend(buildAccessDecision({ timedOutUntil }), NOW));

    expect(error.code).toBe("member_timed_out");
    expect(error.httpStatus).toBe(403);
    expect(error.details).toEqual({ timed_out_until: "2025-01-01T12:30:00.000Z" });
  });

  it("reports the timeout even when the channel also denies posting", () => {
    const timedOutUntil = new Date("2025-01-01T12:30:00.000Z");
    const error = captureError(() =>
      assertCanSend(buildAccessDecision({ timedOutUntil, canSend: false }), NOW),
    );

    expect(error.code).toBe("member_timed_out");
  });

  it("allows sending once the timeout has expired", () => {
    const timedOutUntil = new Date("2025-01-01T11:59:00.000Z");

    expect(() => assertCanSend(buildAccessDecision({ timedOutUntil }), NOW)).not.toThrow();
  });

  it("prioritises a ban over an active timeout", () => {
    const error = captureError(() =>
      assertCanSend(buildAccessDecision({ banned: true, timedOutUntil: new Date("2025-01-01T12:30:00.000Z") }), NOW),
    );

    expect(error.code).toBe("missing_permission");
  });
});

describe("assertCanReadHistory (US-005, US-008, US-009)", () => {
  it("requires both VIEW_CHANNEL and READ_MESSAGE_HISTORY", () => {
    expect(() => assertCanReadHistory(buildAccessDecision())).not.toThrow();
    expect(captureError(() => assertCanReadHistory(buildAccessDecision({ canView: false }))).code).toBe(
      "missing_permission",
    );
    expect(captureError(() => assertCanReadHistory(buildAccessDecision({ canReadHistory: false }))).code).toBe(
      "missing_permission",
    );
  });

  it("rejects non-members and banned users", () => {
    expect(captureError(() => assertCanReadHistory(buildAccessDecision({ isMember: false }))).code).toBe(
      "missing_permission",
    );
    expect(captureError(() => assertCanReadHistory(buildAccessDecision({ banned: true }))).code).toBe(
      "missing_permission",
    );
  });

  it("lets a timed-out member keep reading history", () => {
    expect(() =>
      assertCanReadHistory(buildAccessDecision({ timedOutUntil: new Date("2030-01-01T00:00:00.000Z") })),
    ).not.toThrow();
  });

  it("treats a non-text channel as not found", () => {
    expect(captureError(() => assertCanReadHistory(buildAccessDecision({ channelType: "category" }))).code).toBe(
      "channel_not_found",
    );
  });
});
