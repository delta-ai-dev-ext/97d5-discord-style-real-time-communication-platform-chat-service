import type { MessageService } from "../services/messageService";
import type { RequestScope, RouteResult } from "./respond";

/** Thin request handling: extract → delegate → shape the response. */

export interface ChannelRequest {
  channelId: string;
  query: Record<string, unknown>;
}

export interface SendRequest extends ChannelRequest {
  body: unknown;
}

export interface MessageRequest extends ChannelRequest {
  messageId: string;
  body: unknown;
}

export class MessageController {
  constructor(private readonly service: MessageService) {}

  async list(scope: RequestScope, request: ChannelRequest): Promise<RouteResult> {
    const page = await this.service.list({
      channelId: request.channelId,
      claims: scope.claims,
      query: request.query,
      traceParent: scope.trace.traceParent,
    });

    return { status: 200, body: page };
  }

  async send(scope: RequestScope, request: SendRequest): Promise<RouteResult> {
    const result = await this.service.send({
      channelId: request.channelId,
      claims: scope.claims,
      body: request.body,
      traceParent: scope.trace.traceParent,
    });

    // 201 for a new message, 200 when the client nonce replayed.
    return { status: result.status, body: result.message };
  }

  async edit(scope: RequestScope, request: MessageRequest): Promise<RouteResult> {
    const message = await this.service.edit({
      channelId: request.channelId,
      messageId: request.messageId,
      claims: scope.claims,
      body: request.body,
      traceParent: scope.trace.traceParent,
    });

    return { status: 200, body: message };
  }

  async remove(scope: RequestScope, request: MessageRequest): Promise<RouteResult> {
    await this.service.remove({
      channelId: request.channelId,
      messageId: request.messageId,
      claims: scope.claims,
      traceParent: scope.trace.traceParent,
    });

    return { status: 204 };
  }
}
