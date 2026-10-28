# ADR-002: Fail-closed synchronous access checks against `community_service`

## Status
Accepted

## Date
2025-01-01 (service bootstrap)

## Context
`chat_service` owns no permission data. Whether a user may send to or read a channel depends on community membership, roles, per-channel overwrites, timeouts and bans — all owned by `community_service`. Moderation must take effect immediately: a banned or timed-out member must not be able to send one more message after the moderation action lands.

This makes authorization a **real-time synchronous dependency** on the send/read hot path, which is itself a risk: if `community_service` is slow or down, every send and history read stalls or errors.

## Decision
On every send and every history read, call `GET /internal/v1/channels/{channel_id}/access/{user_id}` with:
- a **300 ms timeout**,
- **one retry** on transient failure,
- **fail closed**: if the access decision cannot be obtained, the request fails with `503 access_unavailable`.

The decision is **never cached across requests**. Edits and deletes of a caller's *own* messages are exempt: they are author-scoped, not permission-scoped (see `docs/architecture.md` §2.2).

## Alternatives Considered

### Cache access decisions for N seconds
- Pros: removes the hot-path dependency; tolerates `community_service` blips.
- Cons: a ban or timeout could remain effective for the cache TTL — an explicit product violation ("enforce access on every send"); stale grant = security hole.
- Rejected.

### Replicate permissions into chat_service's database
- Pros: no runtime dependency at all.
- Cons: violates the "no cross-service table sharing" rule; permission recomputation logic would be duplicated and drift.
- Rejected.

### Fail open during outage
- Pros: availability of chat during community_service incidents.
- Cons: unauthenticated-by-permission posting window; unacceptable.
- Rejected.

## Consequences
- `chat_service` availability is coupled to `community_service` (target 99.95%); the 503 error is part of the public API contract (`docs/openapi_spec.yaml`).
- The 300 ms budget must be met by `community_service` (its own SLO: internal access check p95 < 25 ms).
- Load: one internal call per send/read — acceptable at MVP scale; batched or per-community caching can be introduced later **only** if the immediacy requirement is relaxed product-wide.
- Tests must cover the timeout, retry, and fail-closed paths (see `docs/engineering_guide.md` § Testing Strategy).
