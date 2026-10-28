# ADR-001: Transactional outbox for `chat_message_events`

## Status
Accepted

## Date
2025-01-01 (service bootstrap)

## Context
Every persisted message must reach `realtime_gateway` for live fan-out. Two write targets are involved: PostgreSQL (message rows) and Kafka (events). Publishing to Kafka directly from the request handler after committing the database row creates a dual-write problem:

- Crash between commit and produce → message exists but is never delivered live.
- Kafka producer retry semantics vs. database rollback → events for messages that never existed.
- "Retry failed message" UX requires that the send response, the stored message, and the emitted event can never disagree.

`chat_service` is a stateless pod; it cannot keep in-memory pending queues to bridge the gap.

## Decision
Persist the Kafka event in an `outbox_events` table **in the same database transaction** as the message write. A separate, asynchronous outbox relay polls unpublished rows and publishes them to `chat_message_events` (partition key `channel_id`) with retry/backoff, marking rows `published_at` only after successful acknowledgment.

## Alternatives Considered

### Direct produce after commit
- Pros: simplest code path, lowest latency.
- Cons: dual-write anomaly (lost events on crash); violates the invariant that a persisted message always reaches live subscribers.
- Rejected: correctness of live delivery is a core product behavior.

### CDC/debezium-style log tailing
- Pros: decouples producer entirely from application code.
- Cons: extra infrastructure component, operational complexity, not part of the enforced portable stack for an MVP.
- Rejected: over-engineered at this scale; revisit if event volume grows.

## Consequences
- Request latency no longer includes Kafka produce time; the send SLO (p95 < 150 ms) is easier to meet.
- Event delivery becomes asynchronous with at-least-once semantics; consumers must deduplicate by `event_id`/`message_id` (documented in `docs/architecture.md` §3).
- Outbox lag must be monitored (unpublished-row age) and alerted on sustained growth.
- Relay ordering per channel is preserved because rows are dispatched in `created_at` order and Kafka partitions by `channel_id`.
