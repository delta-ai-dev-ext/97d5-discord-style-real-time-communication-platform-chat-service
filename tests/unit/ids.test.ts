import { describe, expect, it } from "bun:test";
import { generateEventId, generateMessageId, isMessageId } from "../../src/models/ids";

describe("message ids (ADR-003)", () => {
  it("is 26 Crockford base32 characters", () => {
    const id = generateMessageId(1_700_000_000_000);

    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("encodes the timestamp prefix so later messages sort later", () => {
    const earlier = generateMessageId(1_700_000_000_000);
    const later = generateMessageId(1_700_000_001_000);

    expect(later > earlier).toBe(true);
  });

  it("stays strictly increasing within the same millisecond", () => {
    const ids = Array.from({ length: 500 }, () => generateMessageId(1_700_000_000_123));
    const sorted = [...ids].sort();

    expect(new Set(ids).size).toBe(ids.length);
    expect(sorted).toEqual(ids);
  });

  it("stays strictly increasing when the clock moves backwards", () => {
    const first = generateMessageId(1_700_000_005_000);
    const second = generateMessageId(1_700_000_001_000);

    expect(second > first).toBe(true);
  });

  it("defaults to the current clock", () => {
    const id = generateMessageId();

    expect(isMessageId(id)).toBe(true);
  });

  it("accepts the documented cursor example and rejects malformed cursors", () => {
    expect(isMessageId("01JD8W4FQ9Z2X7K3M5A0B1CDEF")).toBe(true);
    expect(isMessageId("01jd8w4fq9z2x7k3m5a0b1cdef")).toBe(false);
    expect(isMessageId("01JD8W4FQ9Z2X7K3M5A0B1CDE")).toBe(false);
    expect(isMessageId("01JD8W4FQ9Z2X7K3M5A0B1CDEFG")).toBe(false);
    expect(isMessageId("01JD8W4FQ9Z2X7K3M5A0B1CDEI")).toBe(false);
    expect(isMessageId("")).toBe(false);
    expect(isMessageId("not-a-cursor")).toBe(false);
  });
});

describe("event ids", () => {
  it("produces uuid v4 values from Bun crypto", () => {
    const id = generateEventId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generateEventId()).not.toBe(id);
  });
});
