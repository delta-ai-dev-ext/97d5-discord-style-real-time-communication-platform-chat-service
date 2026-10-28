# user_stories — chat_service

Stories derived from `SYSTEM_DESIGN.md` §4.3 (`chat_service`) and §7 (cross-cutting concerns).
Actors: **member** — an authenticated community member sending or reading messages in a text channel;
**author** — the member who wrote a specific message.

---

## US-001: Send a message in a text channel

**As a** member,
**I want to** send a text message to a channel I am allowed to post in,
**So that** other members of the community can read it live.

### Acceptance Criteria
- Given an authenticated member with `SEND_MESSAGES` permission in a text channel, when they submit a message of 1–4,000 characters, then it is persisted and the response returns the created message (`201`) including its id, author, content and `created_at`.
- Given a submitted message with empty content, only whitespace, or more than 4,000 characters, when it is submitted, then it is rejected with a validation error (`422`) and nothing is persisted.
- Given the channel is a voice channel or does not exist, when a message is submitted, then the request fails with a clear error (`404`) and nothing is persisted.

### Out of Scope
- File/image attachments (no attachment support in the MVP).
- Delivery over WebSocket (owned by `realtime_gateway`).

---

## US-002: Retry a failed send without duplicates

**As a** member,
**I want to** retry a message send that failed (e.g. network drop) using the same client nonce,
**So that** the "retry failed message" flow never posts the message twice.

### Acceptance Criteria
- Given a member previously submitted `{content, client_nonce}` for a channel and the request failed before a definite answer, when the same `client_nonce` is re-submitted with the same content in the same channel by the same author, then the original message is returned with status `200` (not `201`) and no duplicate message is stored or published.
- Given a `client_nonce` that was never seen for that channel/author, when a message is submitted, then it is created normally (`201`).
- Given the same `client_nonce` re-submitted with different content in the same channel, when the replay occurs, then the original message is still returned and the differing content is ignored.

### Out of Scope
- Retries across different channels or different authors (nonce scope is per channel + author).

---

## US-003: Edit my own message

**As a** member,
**I want to** edit a message I wrote,
**So that** I can fix typos or clarify what I said.

### Acceptance Criteria
- Given the author of a message that is not deleted, when they submit new content of 1–4,000 characters, then the message content is updated, `edited_at` is set, and the updated message is returned (`200`).
- Given a member who is **not** the author of the message, when they attempt to edit it, then the request is rejected (`403`) with a clear error code and the message is unchanged.
- Given an already-deleted message, when the author attempts to edit it, then the request is rejected (`404`) and the message stays deleted.

### Out of Scope
- Editing other users' messages for any role, including moderators or owners.

---

## US-004: Delete my own message

**As a** member,
**I want to** delete a message I wrote,
**So that** I can remove something I did not mean to say.

### Acceptance Criteria
- Given the author of a message that is not already deleted, when they delete it, then it disappears from all subsequent history reads and the response is `204`.
- Given a member who is **not** the author of the message, when they attempt to delete it, then the request is rejected (`403`) and the message remains.
- Given a message that is already deleted, when the author deletes it again, then the result is `404` (the message no longer exists for anyone).

### Out of Scope
- Moderator-initiated deletions (moderation acts on members, not messages; see `community_service`).

---

## US-005: Read channel history with pagination

**As a** member,
**I want to** load the message history of a text channel newest-first in pages,
**So that** I can scroll back through the conversation efficiently.

### Acceptance Criteria
- Given a member with history-read permission in a text channel, when they request history without cursor parameters, then they receive the most recent page of messages (newest first) plus a cursor for the next older page.
- Given a `limit` above 100, a `limit` below 1, or a malformed cursor, when the request is made, then it is rejected with a validation error (`400`/`422`).
- Given a `before` cursor pointing at a message id, when the request is made, then only messages strictly older than that message are returned.

### Out of Scope
- Jump-to-date or search queries within history.

---

## US-006: Backfill missed messages after reconnecting

**As a** member,
**I want to** fetch only the messages posted while my live connection was down using an `after` cursor,
**So that** reconnecting is fast and I do not re-download history I already have.

### Acceptance Criteria
- Given the member's last seen message id, when they request history with `after=<last_seen_message_id>`, then they receive only messages strictly newer than that id, oldest-first-compatible paging, plus a cursor for continuing backfill.
- Given `after` combined with `limit`, when the page is returned, then at most `limit` messages are included and the cursor lets the client fetch the next page until it reaches the present.

### Out of Scope
- Live delivery itself (owned by `realtime_gateway` via Kafka fan-out).

---

## US-007: Sending requires SEND_MESSAGES permission

**As a** community moderator/owner,
**I want to** members without posting rights in a channel to be unable to send messages,
**So that** channel permissions configured in `community_service` are enforced consistently.

### Acceptance Criteria
- Given a member whose effective permissions in the channel deny posting (role, overwrite or membership reasons), when they attempt to send, then the send is rejected (`403`) with error code `missing_permission` and no message is stored.
- Given a non-member of the community (or a banned user), when they attempt to send to any channel, then the send is rejected (`403`) and nothing is stored.
- Given a permission change in `community_service`, when the same member sends afterwards, then the decision reflects the current permissions (the check is authoritative per send).

### Out of Scope
- How permissions are computed (owned by `community_service`).

---

## US-008: Timed-out members cannot send but can still read

**As a** moderator,
**I want to** a member I timed out to be temporarily unable to post,
**So that** they cool down without losing access to the conversation.

### Acceptance Criteria
- Given a member with an active timeout (`timed_out_until` in the future), when they attempt to send, then the send is rejected (`403`) with error code `member_timed_out` and the response includes `timed_out_until` so the client can show when posting resumes.
- Given a member whose timeout has expired, when they attempt to send, then the send succeeds like any other permitted member.
- Given a timed-out member with history-read permission, when they read history, then the read succeeds (timeout only blocks sending).

### Out of Scope
- Imposing or clearing timeouts (owned by `community_service`).

---

## US-009: Reading history requires READ_MESSAGE_HISTORY

**As a** community moderator/owner,
**I want to** members without history-read rights in a channel to be unable to load past messages,
**So that** channel history is not leaked to restricted roles.

### Acceptance Criteria
- Given a member whose effective permissions deny history reading in the channel, when they request history, then the request is rejected (`403`) with error code `missing_permission`.
- Given a member who may send but not read history, when they request history, then the request is still rejected (the two permissions are checked independently).

### Out of Scope
- Permission computation and overrides (owned by `community_service`).

---

## US-010: Channel and community deletion removes their message history

**As a** community owner,
**I want to** a deleted channel's or community's messages to be permanently removed,
**So that** content from deleted communities does not linger as orphaned data.

### Acceptance Criteria
- Given a `channel_deleted` event for a channel of type `text`, when `chat_service` processes it, then all messages of that channel are deleted and the same event delivered again causes no additional work (idempotent processing).
- Given a `community_deleted` event with its channel id list, when `chat_service` processes it, then messages of all listed channels are deleted in a bounded batch and re-delivery is a no-op.
- Given a purge executed while the service restarts mid-way, when processing resumes, then the purge completes without loss or duplicated effort (at-least-once delivery with deduplication).

### Out of Scope
- Deleting message history for other event types (e.g. member leaves/bans do not purge history).
