import { describe, expect, it } from "bun:test";
import { childTraceParent, generateTraceContext, parseTraceParent, resolveTraceContext } from "../../src/trace";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceParent", () => {
  it("extracts the trace id from a valid W3C header", () => {
    const context = parseTraceParent(VALID);

    expect(context).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceParent: VALID,
    });
  });

  it("rejects malformed, all-zero and missing headers", () => {
    expect(parseTraceParent(undefined)).toBeNull();
    expect(parseTraceParent("")).toBeNull();
    expect(parseTraceParent("garbage")).toBeNull();
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceParent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });
});

describe("generateTraceContext", () => {
  it("produces a well-formed traceparent", () => {
    const context = generateTraceContext();

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(parseTraceParent(context.traceParent)).toEqual(context);
    expect(context.traceId).not.toBe(generateTraceContext().traceId);
  });
});

describe("resolveTraceContext", () => {
  it("keeps an inbound trace and creates a new one when absent", () => {
    expect(resolveTraceContext(VALID).traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(resolveTraceContext(null).traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveTraceContext("broken").traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("childTraceParent", () => {
  it("keeps the trace id and issues a fresh span id", () => {
    const parent = resolveTraceContext(VALID);
    const child = childTraceParent(parent);
    const parsed = parseTraceParent(child);

    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).toBe(parent.traceId);
    expect(parsed?.spanId).not.toBe(parent.spanId);
  });
});
