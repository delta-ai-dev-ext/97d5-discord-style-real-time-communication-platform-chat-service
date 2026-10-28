# engineering_guide — chat_service

Persistent technical memory for `chat_service`. Behavioral/flow-level architecture lives in
`docs/architecture.md`; this document governs **how** the service is built, tested and operated.

## Runtime & Toolchain

| Aspect | Choice |
|---|---|
| Language | TypeScript (`strict: true`, `moduleResolution: "bundler"`, target ≥ ES2020) |
| Runtime | **Bun** (`oven/bun:1` base image; execute with `bun` exclusively, never `node`) |
| Package manager | `bun` (`bun add`; lockfile committed; production installs use `--frozen-lockfile`) |
| Module system | ES modules only (`"type": "module"`) |

Makefile targets (all tooling runs via `make`):

| Target | Command |
|---|---|
| `dev` | `bun --watch src/index.ts` |
| `test` | `bun test --coverage` (thresholds ≥ 80% line/branch/function/statement in `bunfig.toml`) |
| `build` | `docker build -t $(SERVICE_NAME):latest .` (executed by CI/workstation; no Docker daemon in the agent runtime) |
| `run` | `bun run src/index.ts` |
| `lint` | `bun x eslint src/ tests/` |

## Libraries & External Provider SDKs

| Concern | Package / Library | Source | Usage Notes |
|---|---|---|---|
| HTTP framework | `elysia` | language-skill | Bun-native, TypeScript-first; routes in `src/routes/`, thin controllers |
| Validation | `zod` | language-skill | Request bodies, query params (`before`/`after`/`limit`), and env config all validated at boundaries |
| ORM | `drizzle-orm` | language-skill | Typed schema for `messages`, `processed_events`, `outbox_events`; parameterized queries only |
| PostgreSQL driver | `pg` | language-skill | `drizzle-orm/node-postgres` with a `Pool` from `DATABASE_URL` |
| Migrations | `drizzle-kit` | tech-lead-research | Companion CLI for generating/running schema migrations (PostgreSQL 18) |
| Kafka client | `kafkajs` | language-skill | Platform-standard client; producer for `chat_message_events` (outbox relay), consumer group `chat_service` for `community_events`; see Pinned Decisions |
| Clerk JWT verification | `@clerk/backend` | tech-lead-research | Offline session-JWT verification via `verifyToken` with the Clerk JWKS/JWT key (claims `sub`, `username`, `email`). No Backend API calls in the request path |
| HTTP client (inter-service) | native `fetch` | language-skill | Calls `community_service` `/internal/v1/channels/{channel_id}/access/{user_id}` with 300 ms timeout + 1 retry; no HTTP client packages |
| Logging | `winston` | language-skill | Structured JSON to stdout; levels error/warn/info/debug |
| Metrics | `prom-client` | language-skill | Registers all metrics from `docs/architecture.md` §7; default `/metrics` exposition |
| Testing | `bun:test` | language-skill | Only approved runner; `*.test.ts` under `tests/` |
| Mocking | `mock()` from `bun:test` | language-skill | Reset all mocks between tests; mocks live in `tests/mocks/` |

No S3-compatible storage client is required (no blobs in this service). No Resend/LiveKit SDKs here — those belong to other services.

## Container Lifecycle & Probes

- **Statelessness**: no session state, caches of authority, or files on disk. Any replica serves any request; safe with `replicas > 1`.
- **`SIGTERM` / `SIGINT` graceful shutdown**:
  1. Flip `/readyz` to `503` immediately.
  2. Stop accepting new HTTP requests; drain in-flight requests (bounded, default `SHUTDOWN_TIMEOUT_SECONDS=25`).
  3. Pause the `community_events` consumer loop and commit offsets of completed work.
  4. Best-effort flush of unpublished outbox rows within the drain window; then close the Kafka producer and PostgreSQL pool; exit `0`.
- **`GET /healthz`** (liveness): process/event-loop responsive → `200`. MUST NOT probe `community_service` or Kafka (prevents restart cascades during dependency incidents).
- **`GET /readyz`** (readiness): `200` only when the PostgreSQL pool answers a trivial query and the Kafka producer is connected; `503` while draining or degraded.

## Testing Strategy

- **Unit tests** (`tests/unit/`): message service rules (nonce idempotency, author-only edit/delete, cursor pagination edge cases, content bounds), access-decision mapping (`can_send`/`timed_out`/`banned` → error codes), outbox relay retry logic. No network calls.
- **Integration tests** (`tests/integration/`): HTTP endpoints through the in-process app with **all external dependencies mocked**:
  - PostgreSQL: in-memory fake repository implementing the same interface; constraint-conflict behavior of the nonce unique index reproduced in the fake.
  - Kafka: fake producer/consumer doubles recording published envelopes; consumer dedupe verified against the fake ledger.
  - `community_service`: `fetch` stub returning canned access payloads, timeout/error variants (verify fail-closed `503`, single retry, 300 ms bound).
  - Clerk JWT verification: stubbed verifier returning fixed claims.
- **Determinism & parallelism**: no shared mutable state between tests, no sleeps/skips; `bun test` runs files in parallel; mocks reset per test.
- **Mocks location**: `tests/mocks/` (fakes, fixtures, stub builders). Prefer fakes over interaction mocks; assert outcomes, not call sequences.

## Coding Conventions & Project Structure

```
src/
├── index.ts            # app factory + server start + signal handling
├── routes/             # Elysia routers grouped by resource (messages, health)
├── controllers/        # thin request handling: parse → delegate → map errors
├── services/           # business logic (no I/O decisions here)
├── repositories/       # drizzle-based SQL access (messages, outbox, processed events)
├── access/             # community_service access client (timeout/retry/fail-closed)
├── events/             # outbox relay + community_events consumer wiring
├── auth/               # Clerk JWT verification middleware
├── models/             # zod schemas + TypeScript types (branded ids: UserId, ChannelId, MessageId)
└── config.ts           # zod-validated env configuration
tests/{unit,integration,mocks}/
```

- **Layering**: routes → controllers → services → repositories; services never import Elysia types; repositories never decide business rules.
- **Error handling**: single typed `AppError(code, httpStatus, message?, details?)`; controllers map to the `{error: {code, message, details?}}` envelope. Codes are stable and match `docs/openapi_spec.yaml` (`member_timed_out`, `missing_permission`, `not_message_author`, `channel_not_found`, `validation_error`, `access_unavailable`). Never expose stack traces or internal errors.
- **Typing**: `strict` TypeScript; branded string types for ids; discriminated unions for event payloads; `any` forbidden.
- **Crypto/randomness**: Bun native `crypto` (`crypto.getRandomValues()`); never the `uuid` package or `Math.random()`.
- Forbidden: Node-specific imports (`fs`, `stream`, Node `crypto`), CommonJS, `console.log`, `axios`, `lodash`, `dotenv` in production.

## Configuration & Secrets Management

12-factor: all configuration from environment variables, validated at startup by a zod schema; fail fast with a structured error log if a required var is missing. Never `.env` in production (local only, gitignored); production secrets come from environment variables injected from your platform secret store.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default `3000`) | HTTP listen port |
| `DATABASE_URL` | yes | PostgreSQL connection string (portable `postgres://…`) |
| `KAFKA_BROKERS` | yes | Comma-separated broker list |
| `KAFKA_CLIENT_ID` | no | Kafka client id (defaults to service name) |
| `KAFKA_SASL_MECHANISM` / `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` / `KAFKA_TLS` | no | Optional broker auth/TLS |
| `CHAT_KAFKA_CONSUMER_GROUP` | no | Consumer group id (default `chat_service`) |
| `COMMUNITY_SERVICE_URL` | yes | Base URL of `community_service` (cluster-internal) |
| `SERVICE_TOKEN` | yes | Service-to-service bearer token for `/internal/v1/*` calls |
| `CLERK_JWKS_URL` or `CLERK_JWT_KEY` | yes | Clerk public key material for offline JWT verification |
| `CLERK_ISSUER` / `CLERK_AUDIENCE` | yes | Expected `iss`/`aud` claims for verification |
| `ACCESS_CHECK_TIMEOUT_MS` | no (default `300`) | community_service access-check timeout |
| `RATE_LIMIT_SEND_PER_MINUTE` | no | Per-user send rate limit (per-pod token bucket) |
| `SHUTDOWN_TIMEOUT_SECONDS` | no (default `25`) | Graceful drain window |
| `LOG_LEVEL` | no (default `info`) | Logging verbosity |

## Observability & Logging Conventions

- **Structured JSON logging**: every log line carries `timestamp`, `level`, `service_name` ("chat_service"), `request_id`, `trace_id`, `operation`, `status`; error logs add stack traces server-side only. Message *content* is never logged.
- **Trace propagation**: inbound W3C `traceparent` accepted on HTTP; the access-check call to `community_service` forwards it; outbox payloads carry `trace_parent` in the event envelope so gateway-side fan-out continues the trace.
- **Metric registration** (prom-client, low-cardinality labels only — never `user_id`, `community_id`, `channel_id`, `request_id`):
  - Business: `chat_messages_sent_total{channel_type}`, `chat_messages_edited_total`, `chat_messages_deleted_total`, `chat_send_rejections_total{reason}`, `chat_send_retries_deduplicated_total`
  - Technical: `http_request_duration_seconds{route,method,status_class}`, `chat_access_check_duration_seconds`, `kafka_produce_errors_total{topic}`, `kafka_consumer_lag{topic,group}`, outbox unpublished-age gauge
- **SLOs** (alerting baselines): send p95 < 150 ms; history read p95 < 200 ms; availability ≥ 99.9%.

## Pinned Decisions

| Dependency / Area | Pin / Constraint | Rationale | Added By | Date |
|---|---|---|---|---|
| Runtime | Bun-only ecosystem (`bun` execute, `bun:test`, `bun add`; never `node`/npm) | Platform standard for all TypeScript services; mandated by the language skill | tech-lead | service bootstrap |
| Kafka client | `kafkajs` (despite dormant upstream maintenance) | Platform-wide consistency across all six services; API is stable and sufficient for this service's producer/consumer needs; revisit only if Kafka 4.x (KIP-848) features become required | tech-lead | service bootstrap |
| JWT verification | `@clerk/backend` `verifyToken`, offline (JWKS/JWT key), no Backend API calls in request path | Official Clerk SDK; matches the platform trust model (§2 of SYSTEM_DESIGN) | tech-lead | service bootstrap |
| Message ids | Time-ordered, lexicographically sortable ids (ULID-style via Bun crypto) | Ids double as pagination cursors and Kafka-ordering-friendly sort keys | tech-lead | service bootstrap |
