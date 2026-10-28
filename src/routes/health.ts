import { Elysia } from "elysia";
import { runRoute } from "../controllers/respond";
import type { ReadinessState } from "../health";
import type { AppLogger } from "../logger";
import type { Metrics } from "../metrics";

export const HEALTHZ_ROUTE = "/healthz";
export const READYZ_ROUTE = "/readyz";
export const METRICS_ROUTE = "/metrics";

export interface HealthRouteDeps {
  readiness: ReadinessState;
  metrics: Metrics;
  logger: AppLogger;
}

export function healthRoutes(deps: HealthRouteDeps) {
  return new Elysia()
    .get(HEALTHZ_ROUTE, () =>
      runRoute({
        route: HEALTHZ_ROUTE,
        method: "GET",
        metrics: deps.metrics,
        logger: deps.logger,
        // Liveness only: no downstream dependency is touched.
        run: async () => ({ status: 200, body: { status: "ok" } }),
      }),
    )
    .get(READYZ_ROUTE, () =>
      runRoute({
        route: READYZ_ROUTE,
        method: "GET",
        metrics: deps.metrics,
        logger: deps.logger,
        run: async () => {
          const report = await deps.readiness.check();

          return {
            status: report.ready ? 200 : 503,
            body: { status: report.ready ? "ok" : "unavailable" },
          };
        },
      }),
    )
    .get(METRICS_ROUTE, async () => {
      const exposition = await deps.metrics.registry.metrics();

      return new Response(exposition, {
        status: 200,
        headers: { "content-type": deps.metrics.registry.contentType },
      });
    });
}
