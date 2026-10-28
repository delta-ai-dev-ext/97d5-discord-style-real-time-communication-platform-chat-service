import { badRequest, invalidCursor } from "../errors";
import { asMessageId, isMessageId } from "./ids";
import type { MessageId } from "./ids";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from "./message";

export interface ListQuery {
  before?: MessageId;
  after?: MessageId;
  limit: number;
}

export type RawQuery = Record<string, unknown>;

function readParam(query: RawQuery, name: string): string | undefined {
  const value = query[name];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw badRequest(`${name} must be a single value`);
  }

  return value;
}

function parseCursor(query: RawQuery, name: string): MessageId | undefined {
  const value = readParam(query, name);

  if (value === undefined) {
    return undefined;
  }

  if (!isMessageId(value)) {
    throw invalidCursor();
  }

  return asMessageId(value);
}

/**
 * Validates the `before`/`after`/`limit` query parameters.
 *
 * `before` and `after` are mutually exclusive paging directions; `limit` is an
 * integer clamped to 1..100 per the OpenAPI contract.
 */
export function parseListQuery(query: RawQuery): ListQuery {
  const before = parseCursor(query, "before");
  const after = parseCursor(query, "after");

  if (before && after) {
    throw badRequest("before and after cannot be combined in one request");
  }

  const rawLimit = readParam(query, "limit");
  let limit = DEFAULT_PAGE_LIMIT;

  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      throw badRequest(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }

    limit = Number(rawLimit);

    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw badRequest(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
  }

  return { ...(before ? { before } : {}), ...(after ? { after } : {}), limit };
}
