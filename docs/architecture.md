# architecture — chat_service

Clean service-level architecture for `chat_service`, derived from `SYSTEM_DESIGN.md` §4.3, §5 and §7.
This document contains responsibilities, flows, data contracts and operational behavior only —
runtime and library choices live in `docs/engineering_guide.md`.

---

## 1. Service Responsibilities & Component Boundaries

`chat_service` is the persistent store and source of truth for **text channel messages**. It:

1. Persists messages sent by members and serves cursor-paginated history (newest-first) with reconnect backfill.
2. Provides idempotent sends via a client-supplied `client_nonce`.
3. Restricts edits and deletes to the message author.
4. Authorizes every send and every history read synchronously against `community_service`'s internal access endpoint.
5. Publishes `message_created` / `message_edited` / `message_deleted` events for live fan-out (delivery itself is `realtime_gateway`'s job).
6. Deletes message history when a text channel or a whole community is deleted, driven by `community_events`.

Internal components (single deployable, stateless):

| Component | Responsibility |
|---|---|
| HTTP API layer | Request validation, JWT verification, error mapping, rate limiting |
| Access authorization client | Calls `community_service` internal access endpoint with a strict timeout and bounded retry |
| Message service | Domain rules: nonce idempotency, author-only mutation, cursor pagination semantics |
| Message repository | SQL persistence against the `messages` table |
| Outbox relay | Publishes committed outbox rows to the `chat_message_events` topic with backoff |
| Community-events consumer | Consumes `community_events`, performs idempotent history purges |
| Health module | `/healthz` (liveness) and `/readyz` (readiness) |

Boundaries respected:
- `chat_service` computes **no** permissions itself; all access decisions come from `community_service`.
- `chat_service` does **not** deliver messages over WebSocket; it only emits Kafka events.
- `chat_service` has no external third-party providers and no object storage.

---

## 2. Synchronous HTTP Flows

### 2.1 Send message — `POST /v1/channels/{channel_id}/messages`

```
Client → chat_service:
  1. Verify Clerk session JWT offline (claims: sub = user_id, username).
  2. Validate body: content 1..4000 chars, non-empty client_nonce.
     Failure → 422 validation_error (nothing persisted).
  3. Per-user rate limit (per-pod token bucket) → reject with 429 rate_limited when exhausted.
  4. Access check (see 2.4) for (channel_id, user_id):
       - not member / banned / can_send=false → 403 missing_permission
       - timed_out_until in the future       → 403 member_timed_out (+ timed_out_until)
       - community_service unreachable/timed out → 503 access_unavailable (fail closed)
  5. Begin transaction:
       a. INSERT message. Unique constraint (channel_id, author, client_nonce):
            - conflict → SELECT existing row, ROLLBACK, respond 200 with the original message.
            - success  → proceed.
       b. INSERT outbox row (event message_created) in the SAME transaction.
       c. COMMIT.
  6. Respond 201 with the message.
  7. Outbox relay (asynchronous, decoupled) publishes the event.
```

Key invariant: **persisting the message and writing the outbox event are atomic** — a message that exists always yields exactly one `message_created` event eventually (at-least-once on the Kafka side).

### 2.2 Edit / delete message — `PATCH|DELETE /v1/channels/{channel_id}/messages/{message_id}`

- No access check against `community_service`: the rule is purely author-scoped (`author_user_id == token.sub`). A member may edit/delete their own historical messages even if they can no longer post in the channel (permissions govern writing *new* content and reading history, not retracting one's own words).
- Wrong author → `403 not_message_author`; unknown or already-soft-deleted message → `404`.
- Edit sets `edited_at`; delete is a soft delete (`deleted_at`) so history reads exclude it and re-deletion answers `404`. Both write a corresponding outbox event (`message_edited` / `message_deleted`) in the same transaction.

### 2.3 Read history — `GET /v1/channels/{channel_id}/messages`

- Access check (2.4) must yield `can_view=true` **and** `can_read_history=true`, else `403 missing_permission`.
- Default: newest-first page starting at the channel head; `before=<id>` paginates strictly older messages; `limit` clamped to 1..100.
- `after=<id>` returns strictly newer messages in ascending order — the reconnect backfill path used by `realtime_gateway` clients that missed live events.
- `next_cursor` is the id of the oldest returned message (for `before` continuation); `null` when the start of history is reached.
- Messages with `deleted_at` are never returned.

### 2.4 Synchronous access check (hot path)

```
GET {COMMUNITY_SERVICE_URL}/internal/v1/channels/{channel_id}/access/{user_id}
Headers: Authorization: Bearer <service-to-service token>, traceparent
Timeout: 300 ms; one retry on transient failure; otherwise FAIL CLOSED (503).
```

- Response is treated as untrusted input and validated against the access contract
  (`community_id, channel_type, is_member, can_view, can_read_history, can_send,
  can_connect, can_speak, can_video, timed_out_until, banned`) before use.
- The check happens on **every** send and **every** history read — never cached across
  requests, because timeout/ban/permission changes must take effect immediately.
- Latency budget: access check + persistence must fit the send SLO p95 < 150 ms.
- No synchronous dependency exists on `identity_service`, `notification_service`, or `realtime_gateway`.

---

## 3. Asynchronous Event Flows

### 3.1 Producer — `chat_message_events`

- Topic: `chat_message_events`; partition key: `channel_id` (per-channel ordering); published via the transactional outbox relay with retry/backoff.
- Envelope (shared platform contract):

```json
{
  "event_id": "<uuid>",
  "event_type": "message_created | message_edited | message_deleted",
  "occurred_at": "<ISO-8601>",
  "producer": "chat_service",
  "version": "1",
  "trace_parent": "<W3C traceparent>",
  "data": { ... }
}
```

| Event | `data` contract |
|---|---|
| `message_created` | `message_id, channel_id, community_id, author_user_id, author_username, content, client_nonce, created_at` |
| `message_edited` | `message_id, channel_id, community_id, content, edited_at` |
| `message_deleted` | `message_id, channel_id, community_id` |

- Consumers: `realtime_gateway` only (all pods, broadcast via pod-unique groups).
- Events are at-least-once: the gateway deduplicates by `message_id` + type; producing a duplicate is acceptable and must never be prevented by weakening the outbox invariant.

### 3.2 Consumer — `community_events` (consumer group `chat_service`)

Handled event types:

| Event | Action |
|---|---|
| `channel_deleted {community_id, channel_id, type}` | If `type=text`: hard-delete all messages of `channel_id`. |
| `community_deleted {community_id, channel_ids[]}` | Hard-delete messages of all listed channels in bounded batches. |
| All other event types | Acknowledged and marked processed without action. |

Processing rules:
- **Idempotency**: before executing, record `event_id` in `processed_events`; if already recorded, ack without work.
- At-least-once delivery ⇒ dedupe on `event_id`, never on message content.
- Offsets are committed only after the dedupe record is persisted, so a crash mid-purge resumes without losing or duplicating work.
- Purges run in bounded batches so a large community deletion cannot stall the consumer or starve the database.

---

## 4. PostgreSQL Database Schema

Logical database owned exclusively by `chat_service`. Message ids are **time-ordered, lexicographically sortable identifiers** so they double as pagination cursors and sort keys.

### `messages`

| Column | Type | Constraints |
|---|---|---|
| `id` | `varchar(32)` | PRIMARY KEY (time-ordered ULID-style) |
| `channel_id` | `varchar` | NOT NULL |
| `community_id` | `varchar` | NOT NULL (denormalized for purge efficiency) |
| `author_user_id` | `varchar` | NOT NULL |
| `author_username` | `varchar` | NOT NULL (snapshot from JWT claim at send time) |
| `content` | `text` | NOT NULL, `CHECK (char_length(content) BETWEEN 1 AND 4000)` |
| `client_nonce` | `varchar(64)` | NOT NULL |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `edited_at` | `timestamptz` | NULL |
| `deleted_at` | `timestamptz` | NULL (soft delete for author deletions) |

Indexes and constraints:
- `UNIQUE (channel_id, author_user_id, client_nonce)` — send idempotency (nonce replays conflict-insert and return the original row).
- `idx_messages_channel_cursor ON messages (channel_id, id DESC) WHERE deleted_at IS NULL` — history pagination and backfill.
- `idx_messages_community ON messages (community_id)` — community-wide purge.

### `processed_events`

| Column | Type | Constraints |
|---|---|---|
| `event_id` | `uuid` | PRIMARY KEY |
| `processed_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |

Consumer idempotency ledger for `community_events`. Rows for old events may be pruned once their topic-partition offsets are safely behind the consumer group.

### `outbox_events`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | PRIMARY KEY |
| `topic` | `varchar` | NOT NULL (`chat_message_events`) |
| `event_type` | `varchar` | NOT NULL |
| `partition_key` | `varchar` | NOT NULL (`channel_id`) |
| `payload` | `jsonb` | NOT NULL (full event envelope including `trace_parent`) |
| `trace_parent` | `varchar` | NULL |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT `now()` |
| `published_at` | `timestamptz` | NULL |

- `idx_outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL` — relay dispatch.
- Published rows are retained for a bounded window and pruned by scheduled cleanup.

No cross-service table sharing; `community_id`/`channel_id`/`user_id` are opaque references owned by `community_service` and `identity_service`.

---

## 5. Stateless Kubernetes Operational Model

- Pods hold **no** state: all durable data lives in PostgreSQL, all fan-out in Kafka. Any replica can serve any request (`replicas >= 1`).
- **Graceful shutdown on `SIGTERM`/`SIGINT`**:
  1. `/readyz` starts failing (503) so Kubernetes stops routing traffic.
  2. Stop accepting new HTTP requests; let in-flight requests finish within a bounded drain window (~15–30 s).
  3. Pause the `community_events` consumer loop and commit offsets of completed work.
  4. Flush pending outbox rows (best effort within the window), close the Kafka producer and the PostgreSQL pool, exit `0`.
- **Probes**:
  - `GET /healthz` (liveness): process/event-loop responsiveness only; MUST NOT fail on `community_service` or Kafka hiccups (avoids restart storms during dependency incidents).
  - `GET /readyz` (readiness): 200 only when the PostgreSQL pool is usable and the Kafka producer is connected; 503 while draining.
- **Rate limiting**: per-user message-send limits enforced per pod with token buckets sized to the replica count (no shared state, per the platform cross-cutting rule).
- **Scaling**: replicas scale independently; the access check is per-request, the outbox relay competes on unpublished rows, and the Kafka consumer group rebalances automatically.

## 6. Failure Modes & Resilience Patterns

| Failure | Behavior |
|---|---|
| `community_service` unavailable / slow | 300 ms timeout, 1 retry, then fail **closed** with `503 access_unavailable`. Never degrade to "allow". |
| DB write failure during send | Transaction rolls back; no message, no outbox row; client sees `500` and may retry (idempotent via nonce). |
| Kafka produce failure | Outbox row remains unpublished; relay retries with backoff. Requests are never blocked on Kafka. |
| Outbox relay outage | Events delayed (lag metric alarms), never lost; ordering per channel preserved by partition key and relay ordering. |
| Consumer crash mid-purge | At-least-once redelivery + `processed_events` dedupe → purge resumes idempotently. |
| Duplicate event delivery | Deduped on `event_id`; second delivery is a no-op. |
| Nonce replay after partial failure | Unique-constraint conflict returns the original message with `200` — the "retry failed message" UX never duplicates. |
| Pod kill | Stateless: clients reconnect to any gateway pod and backfill via `after` cursor reads. |

## 7. Observability

Business metrics (counters, low-cardinality labels only):
- `chat_messages_sent_total{channel_type=text}`
- `chat_messages_edited_total`, `chat_messages_deleted_total`
- `chat_send_rejections_total{reason=timed_out|missing_permission|validation}`
- `chat_send_retries_deduplicated_total` (nonce replays answered from the original row)

Technical metrics:
- `http_request_duration_seconds{route,method,status_class}` (histogram)
- `chat_access_check_duration_seconds` (histogram) — community_service round trips
- `kafka_produce_errors_total{topic}`, `kafka_consumer_lag{topic,group}` (gauge)
- Outbox health: unpublished-row age as a gauge with alerting on sustained growth

SLOs:
- Send p95 < **150 ms** (including access check and persistence)
- History read p95 < **200 ms**
- Availability ≥ **99.9%**

Tracing & logging:
- W3C `traceparent` accepted on inbound HTTP, propagated to the `community_service` call and stored in outbox payloads (`trace_parent` field) so downstream consumers (gateway) can continue traces.
- Structured JSON logs with `trace_id`, `service_name`, `operation`, `status`; error logs include context but never message content beyond id-level metadata, and never stack traces or internal details in API responses.
