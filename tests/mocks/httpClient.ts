import type { ChatApp } from "../../src/index";

export interface HttpCallOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T | null;
  headers: Headers;
}

/**
 * Drives the in-process Elysia app through `app.handle(new Request(...))`, so
 * integration tests exercise the real routing, auth, controller and mapping
 * layers without opening a socket.
 */
export async function httpCall<T = Record<string, unknown>>(
  app: ChatApp,
  path: string,
  options: HttpCallOptions = {},
): Promise<HttpResult<T>> {
  const headers = new Headers(options.headers ?? {});

  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await app.handle(
    new Request(`http://chat.local${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
  );

  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : null;

  return { status: response.status, body, headers: response.headers };
}
