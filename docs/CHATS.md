# Chats (Phase 3)

A chat is an ordinary memento instance: `instance_type = "chat"`, `instance_id = "chat-<id>"`.
Messages, read markers and joins are **events** of that instance, so everything that works
for events works for chats: filters, the Filter DSL, entity history, rendering, `?locale`,
Redis publishing (and the Phase 4 stream). The `memento_chat` row only holds metadata.

| event type | pushed by | payload | en / sr text |
|---|---|---|---|
| `CHAT_MESSAGE_SENT` | `POST /chats/:chat_id/messages` | `{ content, sender_user_id, timestamp }` | `igor sent a message: "…"` / `igor je poslao poruku: "…"` |
| `CHAT_MESSAGE_SEEN` | `POST /chats/:chat_id/seen` | `{ user_id, messages_read_up_to }` (an event id) | `marko read the messages` / `marko je pročitao poruke` |
| `CHAT_PARTICIPANT_ADDED` | `POST /chats/:chat_id/participants` | `{ user_id, added_by? }` | `ana was added to the chat` / `ana je dodat u čat` |

`actor_id` is the sender, the reader, or `added_by` (`null` when nobody is named).
Producers may still push these event types themselves through `POST /memento/events`; the
chat endpoints add the participant checks and keep the chat metadata up to date.

## Model

- **`memento_chat`**: `instance_id` (`chat-…`, unique per tenant), `kind`, `name`,
  `created_at`, `last_message_at` (newest message's `occurred_at`, only moves forward),
  `archived_at` (an archived chat is read-only: writes → `409`).
- **`memento_chat_participant`**: one row per `(chat, user_id)` with `added_at` and the
  read watermark `last_seen_event_id` / `last_seen_at`.
- **kind**: `direct` = exactly two participants, fixed; `room` = members can be added.
  Default: `direct` for two (distinct) participants, `room` otherwise.

## Permissions

API keys belong to a tenant's backend, which acts **on behalf of a user**. Every chat call
names that user (`user_id`), and memento checks that the user is a participant of the chat:

| call | who | otherwise |
|---|---|---|
| send, seen | `user_id` must be a participant | `403 forbidden` |
| add participant | `added_by` (when given) must be a participant | `403` |
| read a chat / its messages | `?user_id=` must be a participant | `403` |
| read without `user_id` | only an `admin`-scope key (moderation, exports) | `403` |

Scopes as for events: writes need `write`, reads `read`. A chat of another tenant is `404`.
The generic `GET /memento/events` stays the tenant-wide backend view (`read` scope, no
per-user check), as before.

## Endpoints

All responses use the usual envelope (`{ ok, data, meta? }`, errors `{ ok:false, error }`).

### `POST /memento/chats` — create a chat (scope `write`)

```json
{ "participants": ["igor", "marko"], "name": "Igor-Marko chat" }
```

Optional: `kind` (`direct` | `room`), `chat_id` (your own id: `123` or `chat-123`; default a
generated UUID). `201` with the chat:

```json
{
  "chat_id": "chat-6f1c…", "instance_type": "chat", "instance_id": "chat-6f1c…",
  "kind": "direct", "name": "Igor-Marko chat",
  "participants": [
    { "user_id": "igor", "added_at": "…", "last_seen_event_id": null, "last_seen_at": null },
    { "user_id": "marko", "added_at": "…", "last_seen_event_id": null, "last_seen_at": null }
  ],
  "created_at": "2026-10-31T10:00:00.000Z", "last_message_at": null, "archived_at": null
}
```

`422` for an invalid body (e.g. a `direct` chat without exactly two participants), `409`
when `chat_id` already exists.

### `GET /memento/chats?user_id=igor` — a user's chats (scope `read`)

Most recently active first (`last_message_at`, else `created_at`). `limit` (1–500, default
50) and `offset`; `meta.next_offset` is `null` on the last page.

### `GET /memento/chats/:chat_id?user_id=igor` — one chat (scope `read`)

The chat with every participant's read watermark.

### `POST /memento/chats/:chat_id/messages[?locale=sr]` — send (scope `write`)

```json
{ "user_id": "igor", "content": "Zdravo Marko!" }
```

Optional `occurred_at` (ISO-8601 with offset; default now). `201`:

```json
{
  "event_id": "9b2e…",
  "message": { "id": "9b2e…", "event_type": "CHAT_MESSAGE_SENT", "instance_type": "chat",
               "instance_id": "chat-6f1c…", "actor_id": "igor",
               "payload": { "content": "Zdravo Marko!", "sender_user_id": "igor",
                            "timestamp": "2026-10-31T10:00:00.000Z" }, … },
  "rendered": "igor sent a message: \"Zdravo Marko!\""
}
```

### `GET /memento/chats/:chat_id/messages?user_id=igor&limit=100&offset=0` — read (scope `read`)

| param | meaning |
|---|---|
| `user_id` | reader; must be a participant (admin keys may omit it) |
| `limit`, `offset` | page size (1–500, default 50) and start; `meta.offset`, `meta.next_offset` |
| `order` | `desc` (default, newest first) or `asc` |
| `event_type` | default `CHAT_MESSAGE_SENT`; `CHAT_*` or `*` for every event of the chat |
| `locale` | render `rendered` in this locale |

### `POST /memento/chats/:chat_id/seen[?locale=sr]` — mark as seen (scope `write`)

```json
{ "user_id": "marko", "up_to_event_id": "9b2e…" }
```

`up_to_event_id` must be a `CHAT_MESSAGE_SENT` event of this chat (`404` otherwise); when
omitted the chat's newest message is used (`409` if there is none). The watermark only
moves forward in `(occurred_at, id)` order. `200`:

```json
{ "event_id": "…", "event": { "event_type": "CHAT_MESSAGE_SEEN", … },
  "rendered": "marko read the messages", "advanced": true,
  "participant": { "user_id": "marko", "last_seen_event_id": "9b2e…", "last_seen_at": "…" } }
```

Marking the same or an older message again is a no-op: `advanced: false`, `event_id`,
`event` and `rendered` are `null`, and **no event is pushed** (so clients can call it
freely, e.g. on every focus).

### `POST /memento/chats/:chat_id/participants[?locale=sr]` — add a room member (scope `write`)

```json
{ "user_id": "ana", "added_by": "igor" }
```

`201` with `{ event_id, event, rendered, participant }`. `409` for a `direct` chat or a user
who is already a participant.

## Querying chat events through `/memento/events`

```bash
# every event of one chat
GET /memento/events?instance_type=chat&instance_id=chat-123
# the whole family: every chat
GET /memento/events?instance_type=chat&instance_id=chat-*
# every message, across all chats
GET /memento/events?event_type=CHAT_MESSAGE_SENT
```

`GET /memento/entities/chat/chat-123/events` is the same history as the first query.

## CLI

```bash
memento create-chat --tenant acme --participants igor,marko --name "Igor-Marko chat"
#   created direct chat chat-6f1c… "Igor-Marko chat": igor, marko
memento send-message --tenant acme --chat-id chat-6f1c… --user igor --content "Zdravo!" [--locale sr]
#   sent 9b2e… to chat-6f1c…: igor sent a message: "Zdravo!"
```

`--tenant` defaults to `$MEMENTO_TENANT`. `create-chat` also takes `--kind direct|room` and
`--chat-id <id>`; `--chat-id` of `send-message` accepts `123` or `chat-123`. `send-message`
renders with the bundled and tenant templates and publishes to Redis when `REDIS_URL` is set,
exactly like the HTTP endpoint. Add `--json` for the full result.
