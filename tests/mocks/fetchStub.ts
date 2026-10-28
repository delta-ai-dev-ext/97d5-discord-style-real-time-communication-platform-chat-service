export interface RecordedFetch {
  url: string;
  init: RequestInit | undefined;
}

export type FetchResponder = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

/**
 * Native-`fetch` double for the `community_service` access client.
 * Records every call and answers with a queued responder.
 */
export class FetchStub {
  readonly calls: RecordedFetch[] = [];
  private responder: FetchResponder;

  constructor(responder: FetchResponder) {
    this.responder = responder;
  }

  setResponder(responder: FetchResponder): void {
    this.responder = responder;
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    this.calls.push({ url, init });

    return this.responder(url, init);
  }) as unknown as typeof fetch;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A responder that hangs until its abort signal fires, like a slow dependency. */
export function hangingResponder(): FetchResponder {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;

      if (!signal) {
        return;
      }

      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
}
