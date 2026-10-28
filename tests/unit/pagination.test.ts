import { describe, expect, it } from "bun:test";
import { asMessageId } from "../../src/models/ids";
import { parseListQuery } from "../../src/models/pagination";
import { AppError } from "../../src/errors";

const CURSOR = "01JD8W4FQ9Z2X7K3M5A0B1CDEF";
const OTHER_CURSOR = "01JD8W4FQ9Z2X7K3M5A0B1CDEG";

function captureError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error("expected parsing to throw");
}

describe("parseListQuery", () => {
  it("defaults to the newest 50 messages", () => {
    expect(parseListQuery({})).toEqual({ limit: 50 });
  });

  it("accepts a before cursor", () => {
    expect(parseListQuery({ before: CURSOR })).toEqual({ before: asMessageId(CURSOR), limit: 50 });
  });

  it("accepts an after cursor for reconnect backfill", () => {
    expect(parseListQuery({ after: CURSOR })).toEqual({ after: asMessageId(CURSOR), limit: 50 });
  });

  it("accepts a numeric limit inside the allowed range", () => {
    expect(parseListQuery({ limit: "1" }).limit).toBe(1);
    expect(parseListQuery({ limit: "100" }).limit).toBe(100);
    expect(parseListQuery({ limit: "25" }).limit).toBe(25);
  });

  it("rejects a malformed cursor with invalid_cursor (400)", () => {
    const error = captureError(() => parseListQuery({ before: "not-a-cursor" }));

    expect(error.code).toBe("invalid_cursor");
    expect(error.httpStatus).toBe(400);
  });

  it("rejects a malformed after cursor", () => {
    expect(captureError(() => parseListQuery({ after: "01jd8w4fq9z2x7k3m5a0b1cdef" })).code).toBe("invalid_cursor");
  });

  it("rejects combining before and after", () => {
    const error = captureError(() => parseListQuery({ before: CURSOR, after: OTHER_CURSOR }));

    expect(error.httpStatus).toBe(400);
    expect(error.code).toBe("validation_error");
  });

  it("rejects limits outside 1..100", () => {
    for (const limit of ["0", "101", "-5", "abc", "10.5", ""]) {
      const error = captureError(() => parseListQuery({ limit }));

      expect(error.httpStatus).toBe(400);
      expect(error.code).toBe("validation_error");
    }
  });
});
