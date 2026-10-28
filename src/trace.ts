/**
 * W3C trace context handling.
 *
 * Inbound `traceparent` headers are accepted and forwarded to
 * `community_service`, and the resulting `trace_parent` is stored in every
 * outbox payload so `realtime_gateway` can continue the trace.
 */

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceParent: string;
}

const TRACE_PARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const TRACE_FLAGS_SAMPLED = "01";

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseTraceParent(header: string | null | undefined): TraceContext | null {
  if (!header) {
    return null;
  }

  const match = TRACE_PARENT_PATTERN.exec(header.trim());

  if (!match) {
    return null;
  }

  const traceId = (match[2] ?? "").toLowerCase();
  const spanId = (match[3] ?? "").toLowerCase();

  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }

  return { traceId, spanId, traceParent: header.trim() };
}

export function generateTraceContext(): TraceContext {
  const traceId = randomHex(16);
  const spanId = randomHex(8);

  return { traceId, spanId, traceParent: `00-${traceId}-${spanId}-${TRACE_FLAGS_SAMPLED}` };
}

/** Uses the inbound trace when it is valid, otherwise starts a new one. */
export function resolveTraceContext(header: string | null | undefined): TraceContext {
  return parseTraceParent(header) ?? generateTraceContext();
}

/** A `traceparent` for an outbound call/event: same trace, fresh span. */
export function childTraceParent(context: TraceContext): string {
  return `00-${context.traceId}-${randomHex(8)}-${TRACE_FLAGS_SAMPLED}`;
}
