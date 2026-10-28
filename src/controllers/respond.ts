import { AppError, internalError, isAppError, unauthorized } from "../errors";
import type { AppLogger } from "../logger";
import { generateEventId } from "../models/ids";
import type { Metrics } from "../metrics";
import { resolveTraceContext } from "../trace";
import type { TraceContext } from "../trace";
import type { SessionClaims, TokenVerifier } from "../auth/types";

/** Thin HTTP helpers shared by the route handlers. */

export interface RouteResult {
  status: number;
  body?: unknown;
}

export interface RequestScope {
  claims: SessionClaims;
  trace: TraceContext;
  requestId: string;
  logger: AppLogger;
}

export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  if (body === undefined) {
    return new Response(null, { status, headers });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Maps anything a handler can throw onto the public error contract. */
export function toAppError(error: unknown, logger: AppLogger): AppError {
  if (isAppError(error)) {
    return error;
  }

  logger.error("unhandled request failure", {
    operation: "http",
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  });

  return internalError();
}

export interface RunRouteOptions {
  route: string;
  method: string;
  metrics: Metrics;
  logger: AppLogger;
  run: () => Promise<RouteResult>;
}

/**
 * Executes a handler, renders the error envelope, and records the HTTP
 * duration metric with a low-cardinality route label.
 */
export async function runRoute(options: RunRouteOptions): Promise<Response> {
  const startedAt = performance.now();
  let status = 500;

  try {
    const result = await options.run();
    status = result.status;

    return jsonResponse(result.status, result.body);
  } catch (error) {
    const appError = toAppError(error, options.logger);
    status = appError.httpStatus;

    return jsonResponse(status, appError.toEnvelope());
  } finally {
    options.metrics.observeHttpRequest(
      { route: options.route, method: options.method, status },
      (performance.now() - startedAt) / 1000,
    );
  }
}

export function readBearerToken(headers: Headers): string {
  const header = headers.get("authorization");

  if (!header) {
    throw unauthorized();
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match || !match[1]) {
    throw unauthorized();
  }

  return match[1];
}


/**
 * Any failure to verify a bearer token is an authentication failure: a verifier
 * bug must never surface as a 500.
 */
async function verifyTokenOrReject(verifier: TokenVerifier, token: string, logger: AppLogger): Promise<SessionClaims> {
  try {
    return await verifier.verify(token);
  } catch (error) {
    if (isAppError(error)) {
      throw error;
    }

    logger.warn("session verification failed", {
      operation: "auth",
      status: "unauthorized",
      error: error instanceof Error ? error.message : String(error),
    });

    throw unauthorized();
  }
}

export interface BuildScopeOptions {
  request: Request;
  verifier: TokenVerifier;
  logger: AppLogger;
}

/** Authenticates the caller and resolves the trace context for one request. */
export async function buildRequestScope(options: BuildScopeOptions): Promise<RequestScope> {
  const requestId = options.request.headers.get("x-request-id") ?? generateEventId();
  const trace = resolveTraceContext(options.request.headers.get("traceparent"));
  const token = readBearerToken(options.request.headers);
  const claims = await verifyTokenOrReject(options.verifier, token, options.logger);

  return {
    claims,
    trace,
    requestId,
    logger: options.logger.child({ request_id: requestId, trace_id: trace.traceId }),
  };
}
