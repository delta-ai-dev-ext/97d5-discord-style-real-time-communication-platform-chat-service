/**
 * Time-ordered, lexicographically sortable identifiers (ADR-003).
 *
 * A message id is `Crockford base32(48-bit unix millis) + Crockford base32(80 random bits)`
 * — 26 characters, sortable as a plain string, and doubling as the pagination
 * cursor. Randomness comes from Bun's native `crypto.getRandomValues()`
 * (never `Math.random()` and never the `uuid` package).
 */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BITS = BigInt(RANDOM_CHARS * 5);
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;

export const MESSAGE_ID_LENGTH = TIME_CHARS + RANDOM_CHARS;

const MESSAGE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type UserId = Brand<string, "UserId">;
export type ChannelId = Brand<string, "ChannelId">;
export type CommunityId = Brand<string, "CommunityId">;
export type MessageId = Brand<string, "MessageId">;

export const asUserId = (value: string): UserId => value as UserId;
export const asChannelId = (value: string): ChannelId => value as ChannelId;
export const asCommunityId = (value: string): CommunityId => value as CommunityId;
export const asMessageId = (value: string): MessageId => value as MessageId;

let lastTimestampMs = -1;
let lastRandom = 0n;

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";

  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD_ALPHABET.charAt(Number(remaining & 31n)) + encoded;
    remaining >>= 5n;
  }

  return encoded;
}

function randomSuffix(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value & RANDOM_MASK;
}

/**
 * Generates the next message id.
 *
 * Ids are strictly increasing within a process even when the clock does not
 * advance (or moves backwards), so `ORDER BY id` is always insertion order and
 * cursors never repeat.
 */
export function generateMessageId(now: number = Date.now()): string {
  let timestampMs = Math.max(0, Math.floor(now));

  if (timestampMs > lastTimestampMs) {
    lastTimestampMs = timestampMs;
    lastRandom = randomSuffix();
  } else {
    timestampMs = lastTimestampMs;
    lastRandom = (lastRandom + 1n) & RANDOM_MASK;

    if (lastRandom === 0n) {
      lastTimestampMs += 1;
      timestampMs = lastTimestampMs;
    }
  }

  return encodeBase32(BigInt(timestampMs), TIME_CHARS) + encodeBase32(lastRandom, RANDOM_CHARS);
}

export function isMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(value);
}

/** UUID v4 built from `crypto.getRandomValues()` — used for event/outbox ids. */
export function generateEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
