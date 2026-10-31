# Real-time streaming — `GET /memento/ws` (Phase 4)

Every event memento stores is pushed, as it is stored, to the WebSocket clients of the
same tenant whose filter it matches. The stream is live only: it carries what is stored
after the client was welcomed. Use `GET /memento/events` for history.

```
POST /memento/events ─┐                                       ┌─▶ client ?event_type=USER_LOGIN
POST /memento/chats/… ┤ store ─▶ publish ─▶ feed ─▶ StreamHub ─┼─▶ client ?instance_type=chat&instance_id=chat-123
                      │  (PG)    Redis: memento:events:<tenant> └─▶ client (no filter: everything)
```

## Connecting

```js
const ws = new WebSocket(
  "ws://localhost:8000/memento/ws?instance_type=chat&instance_id=chat-acme-sales",
  ["memento.v1", `bearer.${apiKey}`],
);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

- **Auth.** Browsers cannot set headers on a WebSocket, so the API key goes in the
  subprotocol list as `bearer.<api_key>`. Offer `memento.v1` next to it: the server selects
  `memento.v1` and the key is not echoed back in the handshake. Non-browser clients may send
  `Authorization: Bearer <key>` or `X-Api-Key` instead. The key needs the `read` scope.
  `@memento/core` has `streamSubprotocols(key)` for the list.
- **Refusals happen before the upgrade**, as ordinary HTTP responses with the usual error
  envelope: `401` missing/invalid/revoked key, `403` key without `read`, `422` invalid filter
  (unknown parameter, malformed `event_type`, …). A plain `GET` without `Upgrade` is a `400`.
- **Tenant isolation.** The tenant is the key's tenant; nothing in the URL can change it.
  Each tenant's events travel on their own Redis channel, and the hub only offers an event
  to connections of the tenant it was published for.

### Filters (query string)

All optional; every one that is set must match exactly (AND).

| parameter | example | |
|---|---|---|
| `event_type` | `?event_type=USER_LOGIN` | only that type |
| `instance_type` | `?instance_type=chat` | one kind of entity |
| `instance_id` | `?instance_type=chat&instance_id=chat-123` | one entity (one chat) |
| `actor_id` | `?actor_id=igor` | what this actor did |
| `locale` | `?locale=sr` | re-render `rendered` in this locale (not a filter) |

Without `locale` an event arrives with the `rendered` text it was stored with.

### Client: `MementoStream` (`@memento/core`)

The browser, `@memento/react` and `memento tail` share one client. It handles the subprotocol
auth, waits for the welcome, and reconnects with exponential backoff (0.5 s → 15 s, reset
after each welcome).

```ts
import { MementoStream } from "@memento/core";
const stream = new MementoStream({
  baseUrl: "http://localhost:8000/memento",          // or "/memento" in a browser
  apiKey,
  filter: { instance_type: "chat", instance_id: "chat-123" },
  onEvent: (event) => console.log(event.rendered),
  onStatus: (status) => console.log(status),          // connecting | live | offline | closed
});
// … stream.close();
```

`liveFilter(query)` splits a `GET /events`-style query that may contain `prefix*` values
into the exact filter `/ws` accepts and a predicate for the rest.

## Messages (server → client, JSON text frames)

Schemas: `StreamMessageSchema` in `@memento/core` (`src/stream.ts`).

**`memento.welcome`** — first message. When it arrives the connection is subscribed: every
event stored from now on that matches is delivered.

```json
{
  "kind": "memento.welcome",
  "payload": {
    "protocol_version": "1",
    "tenant": "acme",
    "filter": { "instance_type": "chat", "instance_id": "chat-acme-sales" },
    "heartbeat_interval_ms": 30000,
    "max_buffered_messages": 1000
  }
}
```

**`memento.event.new`** — a stored event. `id` is the event id, `payload` the event exactly
as `POST /memento/events` returned it (so it also carries `id`, `received_at`, the event's own
`payload`, `rendered_locale`, `archived_at`).

```json
{
  "kind": "memento.event.new",
  "id": "0199a3c1-…",
  "payload": {
    "id": "0199a3c1-…",
    "event_type": "CHAT_MESSAGE_SENT",
    "instance_type": "chat",
    "instance_id": "chat-acme-sales",
    "actor_id": "igor",
    "occurred_at": "2026-10-30T21:00:00.000Z",
    "received_at": "2026-10-30T21:00:00.120Z",
    "payload": { "content": "Pozdrav!", "sender_user_id": "igor", "timestamp": "…" },
    "rendered": "igor je poslao poruku: \"Pozdrav!\"",
    "rendered_locale": "sr",
    "archived_at": null
  }
}
```

Events reach a client in the order the hub received them.

**`memento.pong`** — answer to a client's `{"kind":"memento.ping"}` (an application-level
ping for clients that cannot see WebSocket ping frames). **`memento.error`** —
`{"kind":"memento.error","payload":{"code":"bad_request","message":"…"}}` for any other
client message; the connection stays open. The stream has no other client messages:
filters are fixed for the life of a connection — reconnect to change them.

## Lifecycle

| | |
|---|---|
| connect | auth + filter check → upgrade → tenant subscribed (first connection of a tenant subscribes its Redis channel) → `memento.welcome` |
| heartbeat | every 30 s (`MEMENTO_WS_HEARTBEAT_MS`) the server sends a WebSocket ping; a client that has not answered the previous one (pong, or any message) is terminated. Browsers and `ws` answer pings automatically. |
| slow consumer | messages not yet written to the client's socket are counted; when 1000 (`MEMENTO_WS_MAX_BUFFERED`) are pending the next one is not queued: a warning `slow consumer threshold exceeded; disconnecting` is logged and the connection is closed with **4008 `slow consumer`** (terminated 5 s later if the close does not get through). Other clients are not affected. |
| disconnect | the connection is removed; the last connection of a tenant unsubscribes its channel |
| shutdown | every connection is closed with **1001 `server shutting down`** |
| feed down | if the tenant's channel cannot be subscribed, the connection is closed with **1011** |

Reconnect after any close, with backoff; fetch what you missed with
`GET /memento/events?order=asc&…` from the last `occurred_at` you saw.

## Deployment

- **With `REDIS_URL`** every server process publishes stored events on
  `<REDIS_CHANNEL_PREFIX>:<tenant_slug>` (`RedisPublisher`) and subscribes to the channels of
  tenants it has clients for on one dedicated connection (`RedisFeed`). An event stored by any
  process reaches the clients of every process.
- **Without `REDIS_URL`** a `LocalBus` is both publisher and feed: one process streams its
  own events in memory.
- **Embedded:** pass `stream: { feed }` to `mementoPlugin` (`heartbeatIntervalMs`,
  `maxBufferedMessages` optional). Without `stream` there is no `/ws` route and `/describe`
  reports `realtime: false`. If the host app already registered `@fastify/websocket` it is
  reused; register it before the memento plugin.

The channel per tenant is the Phase 1 publishing contract (`memento:events:<tenant_slug>`):
the stream subscribes to exactly those channels rather than to one shared `memento:events`
channel, so other subscribers of Phase 1 keep working and a process only receives the
tenants it has clients for.
