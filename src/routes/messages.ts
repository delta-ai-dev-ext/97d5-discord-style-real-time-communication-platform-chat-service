import { Elysia } from "elysia";
import type { TokenVerifier } from "../auth/types";
import type { MessageController } from "../controllers/messageController";
import { buildRequestScope, runRoute } from "../controllers/respond";
import type { AppLogger } from "../logger";
import type { Metrics } from "../metrics";

/** Route labels stay low-cardinality: the path pattern, never the raw path. */
export const LIST_MESSAGES_ROUTE = "/v1/channels/:channel_id/messages";
export const MESSAGE_ITEM_ROUTE = "/v1/channels/:channel_id/messages/:message_id";

export interface MessageRouteDeps {
  controller: MessageController;
  verifier: TokenVerifier;
  metrics: Metrics;
  logger: AppLogger;
}

interface MessageRouteContext {
  request: Request;
  params: Record<string, string | undefined>;
  query: Record<string, unknown>;
  body: unknown;
}

function readPathParam(params: Record<string, string | undefined>, name: string): string {
  return params[name] ?? "";
}

export function messageRoutes(deps: MessageRouteDeps) {
  const { controller, verifier, metrics, logger } = deps;

  return new Elysia()
    .get(LIST_MESSAGES_ROUTE, (context) =>
      runRoute({
        route: LIST_MESSAGES_ROUTE,
        method: "GET",
        metrics,
        logger,
        run: async () => {
          const { request, params, query } = context as unknown as MessageRouteContext;
          const scope = await buildRequestScope({ request, verifier, logger });

          return controller.list(scope, {
            channelId: readPathParam(params, "channel_id"),
            query: query as Record<string, unknown>,
          });
        },
      }),
    )
    .post(LIST_MESSAGES_ROUTE, (context) =>
      runRoute({
        route: LIST_MESSAGES_ROUTE,
        method: "POST",
        metrics,
        logger,
        run: async () => {
          const { request, params, body } = context as unknown as MessageRouteContext;
          const scope = await buildRequestScope({ request, verifier, logger });

          return controller.send(scope, {
            channelId: readPathParam(params, "channel_id"),
            query: {},
            body,
          });
        },
      }),
    )
    .patch(MESSAGE_ITEM_ROUTE, (context) =>
      runRoute({
        route: MESSAGE_ITEM_ROUTE,
        method: "PATCH",
        metrics,
        logger,
        run: async () => {
          const { request, params, body } = context as unknown as MessageRouteContext;
          const scope = await buildRequestScope({ request, verifier, logger });

          return controller.edit(scope, {
            channelId: readPathParam(params, "channel_id"),
            messageId: readPathParam(params, "message_id"),
            query: {},
            body,
          });
        },
      }),
    )
    .delete(MESSAGE_ITEM_ROUTE, (context) =>
      runRoute({
        route: MESSAGE_ITEM_ROUTE,
        method: "DELETE",
        metrics,
        logger,
        run: async () => {
          const { request, params } = context as unknown as MessageRouteContext;
          const scope = await buildRequestScope({ request, verifier, logger });

          return controller.remove(scope, {
            channelId: readPathParam(params, "channel_id"),
            messageId: readPathParam(params, "message_id"),
            query: {},
            body: undefined,
          });
        },
      }),
    );
}
