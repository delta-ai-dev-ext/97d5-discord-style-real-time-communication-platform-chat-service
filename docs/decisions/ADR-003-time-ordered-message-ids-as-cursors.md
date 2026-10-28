# ADR-003: Time-ordered message ids double as pagination cursors

## Status
Accepted

## Date
2025-01-01 (service bootstrap)

## Context
History reads need stable, efficient cursor pagination (newest-first browsing plus `after`-based reconnect backfill). Candidates:

1. Sequential integer ids from a Postgres sequence — non-portable with sharding, and inserts serialize around the sequence; gaps after rollbacks complicate "strictly older/newer" semantics less than timestamps but interleave poorly across channels.
2. Random UUIDv4 ids + a separate numeric ordering column — needs an extra sort key and index; cursor pagination must use a compound `(created_at, tiebreaker)` cursor, which is more complex and drifts if clocks skew across app servers.
3. Time-ordered, lexicographically sortable ids (ULID-style: timestamp prefix + randomness) generated in the application.

Constraints: multi-instance inserts must not require coordination; cursors must be opaque, single-value, and stable across replays; the reconnect backfill needs "everything after message X".

## Decision
Generate **time-ordered, lexicographically sortable message ids** (48-bit Unix-millisecond timestamp + random suffix) in the application using Bun's native crypto. The id is the primary key, the pagination cursor (`before`/`after`), and the sort key. History queries use `(channel_id, id)` ordering with a partial index on non-deleted rows.

## Alternatives Considered

- **Serial BIGINT**: couples id generation to a single database node, leaks total message volume, complicates retry semantics.
- **UUIDv4 + compound timestamp cursor**: forces two-column cursors everywhere and extra indexes.
- **Server clock timestamps alone**: collisions between same-millisecond inserts require tiebreakers anyway.

## Consequences
- Single-column cursors; simpler and stable OpenAPI contract (`message_id` is the cursor).
- Index `idx_messages_channel_cursor (channel_id, id DESC) WHERE deleted_at IS NULL` serves both browsing and backfill.
- Ids encode creation time (coarse); this is not considered sensitive for the MVP.
- Clock skew across pods only affects ordering granularity within the same millisecond window; per-channel ordering correctness relies on Kafka partitioning by `channel_id` and the outbox relay's ordered dispatch.
