# JSMemento HTTP API (Phases 1–4)

Base path: `/memento` (configurable with `MEMENTO_API_PREFIX`). All bodies are JSON.
Architecture and schemas: [ARCHITECTURE.md](ARCHITECTURE.md). Chat endpoints
(`/memento/chats…`): [CHATS.md](CHATS.md). Real-time WebSocket stream (`/memento/ws`):
[STREAMING.md](STREAMING.md).

## Authentication

Every endpoint except `/api/health` and `/api/demo` needs an API key, sent either way:

```
Authorization: Bearer mk_ab12cd34_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
X-Api-Key: mk_ab12cd34_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

A key is bound to one tenant: everything you push or read belongs to that tenant only.
Create keys with the CLI:

```bash
pnpm memento create-tenant acme --name "Acme Inc"
pnpm memento create-key --tenant acme --scopes read,write --name backend-prod
```

| scope | allows |
|---|---|
| `read` | `GET /events`, `POST /events/query`, `GET /entities/…/events`, `GET /describe`, `GET /chats…` |
| `write` | `POST /events`, `POST /chats…` |
| `admin` | everything; may read chats without naming a participant `user_id` |

## Envelope

Success:
```json
{ "ok": true, "data": { … }, "meta": { "limit": 50, "count": 50, "next_cursor": "WyIyMDI2…" } }
```
`meta` is present on list endpoints only.

Error:
```json
{
  "ok": false,
  "error": { "code": "validation_error", "message": "invalid event", "details": [ … ] },
  "request_id": "6f1c…"
}
```

| code | HTTP |
|---|---|
| `bad_request` | 400 (also 413 / 415 for body size / content type) |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `validation_error` | 422 — `details` lists the Zod issues (`path`, `message`, …) |
| `internal_error` | 500 |

Every response carries `X-Request-Id`. Send your own (`[A-Za-z0-9_.:-]{1,128}`) to correlate
logs across services; otherwise a UUID is generated.

---

## `POST /memento/events` — push an event

Scope: `write`.

| field | type | required | rules |
|---|---|---|---|
| `event_type` | string | yes | `SCREAMING_SNAKE_CASE`, ≤ 100 |
| `instance_type` | string | yes | lower `snake_case`, ≤ 64 |
| `instance_id` | string \| integer | yes | 1–200 chars after trimming; stored as string |
| `actor_id` | string \| integer \| null | no | stored as string |
| `payload` | object | no | any JSON object, default `{}` |
| `occurred_at` | ISO-8601 with offset | no | default: time of receipt |
| `rendered` | string \| null | no | pre-rendered text, stored verbatim and never translated; when absent memento renders it from the templates |

Unknown fields are rejected (`422`) — in particular you cannot pass a `tenant_id`.

Query string: `?locale=sr` renders `rendered` in that locale (default `MEMENTO_DEFAULT_LOCALE`,
`en`; chain `sr-Latn → sr → en`). `NOTE` events need `payload.text`, which becomes `rendered`
verbatim. With `MEMENTO_LOOKUPS_STRICT=true`, event/instance/actor types outside
`lookups.yaml` are rejected (`422`, `details: [{ section, value, message }]`); otherwise they
are recorded as candidates. See [TEMPLATES.md](TEMPLATES.md).

```bash
curl -X POST http://localhost:8000/memento/events \
  -H "Authorization: Bearer $MEMENTO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor","payload":{"ip":"10.0.0.1"}}'
```

`201 Created`:
```json
{
  "ok": true,
  "data": {
    "id": "3d5dd688-e169-4294-a0d5-c3b4e5b9aba8",
    "occurred_at": "2026-10-30T23:56:08.470Z",
    "received_at": "2026-10-30T23:56:08.473Z",
    "event_type": "USER_LOGIN",
    "instance_type": "user",
    "instance_id": "42",
    "actor_id": "igor",
    "payload": { "ip": "10.0.0.1" },
    "rendered": "User igor logged in from 10.0.0.1.",
    "rendered_locale": "en",
    "archived_at": null
  }
}
```

After storing, the event is published (same JSON as `data`) on the Redis channel
`memento:events:<tenant_slug>` when `REDIS_URL` is configured, and streamed to the tenant's
WebSocket clients (`GET /memento/ws`, below). A Redis failure does not fail the push.

Invalid event → `422`:
```json
{
  "ok": false,
  "error": {
    "code": "validation_error",
    "message": "invalid event",
    "details": [{ "code": "invalid_format", "path": ["event_type"],
                  "message": "event_type must be SCREAMING_SNAKE_CASE (e.g. USER_LOGIN)" }]
  },
  "request_id": "747ff203-2586-45c6-ba8d-35f4e40afa1a"
}
```

## `GET /memento/events` — list events

Scope: `read`. Newest first by default; archived events are hidden.

| param | meaning |
|---|---|
| `event_type` | exact, or prefix with a trailing `*` (`CHAT_MESSAGE_*`) |
| `instance_type` | exact or `prefix*` |
| `instance_id` | exact or `prefix*` (`igor-*`) |
| `actor_id` | exact or `prefix*` |
| `after` | `occurred_at >= after` (ISO-8601 with offset) |
| `before` | `occurred_at < before` |
| `limit` | 1–500, default 50 |
| `cursor` | `meta.next_cursor` of the previous page |
| `offset` | skip N events instead (0–100000); the response adds `meta.offset` and `meta.next_offset`; cannot be combined with `cursor` (`400`) |
| `order` | `desc` (default) or `asc` |
| `include_archived` | `true`/`1` to include soft-deleted events |
| `locale` | render `rendered` in this locale (`sr`, `sr-Latn`, …); stored text in another locale is re-rendered in the response, verbatim text (`rendered_locale: null`) is returned as is |

```bash
curl "http://localhost:8000/memento/events?instance_type=user&instance_id=42&event_type=USER_LOGIN&limit=100" \
  -H "Authorization: Bearer $MEMENTO_KEY"
```

```json
{
  "ok": true,
  "data": [ { "id": "…", "event_type": "USER_LOGIN", "instance_type": "user", "instance_id": "42", … } ],
  "meta": { "limit": 100, "count": 1, "next_cursor": null }
}
```

Paging: repeat the same query with `&cursor=<meta.next_cursor>` until `next_cursor` is
`null`. Cursors are keyset positions `(occurred_at, id)`: pages never skip or repeat rows,
even while events are being pushed. An invalid cursor → `400 bad_request`.

## `POST /memento/events/query` — list with the Filter DSL

Scope: `read`. Same response as `GET /events`. Body: any of the `GET` parameters plus
`filter` (see the DSL in [ARCHITECTURE.md §2](ARCHITECTURE.md#filter-dsl)).

```bash
curl -X POST http://localhost:8000/memento/events/query \
  -H "Authorization: Bearer $MEMENTO_KEY" -H "Content-Type: application/json" \
  -d '{
    "filter": { "and": [
      { "field": "instance_type", "op": "eq", "value": "ticket" },
      { "field": "event_type", "op": "in", "value": ["TICKET_CREATED", "TICKET_MODIFIED"] },
      { "field": "occurred_at", "op": "between", "value": ["2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"] },
      { "not": { "field": "actor_id", "op": "is_null", "value": true } }
    ]},
    "limit": 20
  }'
```

## `GET /memento/entities/:instance_type/:instance_id/events` — entity history

Scope: `read`. The history of one entity; accepts the same query parameters as
`GET /events` (`instance_type`/`instance_id` in the query are ignored — the path wins,
and the path id is matched exactly, `*` is not a wildcard here).

```bash
curl "http://localhost:8000/memento/entities/chat/igor-marko-2026-10/events?order=asc" \
  -H "Authorization: Bearer $MEMENTO_KEY"
```

## `GET /memento/describe` — collection info

Scope: `read`. What this server can do for the key's tenant.

```json
{
  "ok": true,
  "data": {
    "name": "memento",
    "protocol_version": "1",
    "collection": "events",
    "tenant": { "slug": "acme", "name": "Acme Inc" },
    "capabilities": { "push": true, "query": true, "entity_history": true,
                      "realtime": true, "templates": true, "seen": false, "star": false,
                      "chats": true },
    "scopes": ["read", "write", "admin"],
    "schema": { "event_input": { "type": "object", … JSON Schema … }, "event": { … } },
    "filter": { "fields": ["event_type", "instance_type", "instance_id", "actor_id", "occurred_at", "received_at"],
                "ops": ["eq", "ne", "lt", "lte", "gt", "gte", "prefix", "contains", "in", "nin", "between", "is_null"] },
    "pagination": { "default_limit": 50, "max_limit": 500, "style": "cursor" },
    "view": { "collection": "events", "title": "Events", "columns": [ … ],
              "default_sort": { "field": "occurred_at", "dir": "desc" }, "page_size": 50, "filters": [ … ] }
  }
}
```

## `GET /memento/ws` — real-time stream (WebSocket)

Scope `read`. Key as subprotocol `bearer.<key>` (offer `memento.v1` too), or
`Authorization: Bearer`. Filters: `event_type`, `instance_type`, `instance_id`, `actor_id`
(exact match, ANDed); `locale` re-renders `rendered`. Refused before the upgrade with `401`
/ `403` / `422`; a plain GET is `400`.

```
→ ws://localhost:8000/memento/ws?event_type=USER_LOGIN   Sec-WebSocket-Protocol: memento.v1, bearer.mk_…
← {"kind":"memento.welcome","payload":{"protocol_version":"1","tenant":"acme","filter":{"event_type":"USER_LOGIN"},"heartbeat_interval_ms":30000,"max_buffered_messages":1000}}
← {"kind":"memento.event.new","id":"0199…","payload":{"id":"0199…","event_type":"USER_LOGIN", … the stored event … }}
```

Heartbeat ping every 30 s; slow consumers (1000 unwritten messages) are closed with `4008`;
shutdown closes with `1001`. Full protocol: [STREAMING.md](STREAMING.md).

## `POST /memento/udc/<action>` — UDC collections

The list side of memento in the [UDC protocol](https://github.com/digital-cube/jsudc-core),
served by `@jsudc/server`: what `@jsudc/react`'s `UdcDataView` reads. Every action is a
`POST` with the payload as JSON body, answered with **HTTP 200** and an envelope whose `kind`
says ok or err (`udc.list.ok` / `udc.list.err`). Key as `Authorization: Bearer` /
`X-Api-Key`; `read` scope for reads, `write` for mutations. A missing or invalid key, or one
without the scope, is answered in-protocol: `{"kind":"udc.list.err","payload":{"code":"forbidden",…}}`.

| collection | rows |
|---|---|
| `events` | every live (not archived) event of the key's tenant: `occurred_at`, `event_type`, `instance_type`, `instance_id`, `actor_id`, `rendered`, `payload` (json), `received_at` |
| `cpu_load` | `CPU_LOAD` events only, `payload.load_1min/5min/15min` as decimal columns; table + chart |
| `menu` | the examples site's sidebar: `menu.yaml` (`MEMENTO_MENU_PATH`) as flat tree rows (`code`, `translation_key`, `icon`, `url`, `parent_id`, `order`, `depth`, `ancestor_ids`, `children_count`, `is_dynamic`), `source_kind: yaml_menu`. Its `udc:collections` branch lists every collection served, this one included. Not tenant data: the same for every key. Only when the file exists. |

Actions: `collections`, `describe`, `list` (filter DSL, sort, offset paging, exact `total`),
`read`. Every collection is read-only — events are immutable, push them with
`POST /memento/events`; `mutate` and the schema edits answer `unsupported_op`.

```bash
curl -s localhost:8000/memento/udc/list -H "Authorization: Bearer mk_…" \
  -H 'content-type: application/json' \
  -d '{"collection":"cpu_load","filter":{"field":"load_1min","op":"gt","value":2},
       "sort":[{"field":"occurred_at","dir":"desc"}],"page":{"limit":2}}'
# {"kind":"udc.list.ok","id":"","payload":{"rows":[{"__meta":{"id":"2cb9…","version":1},
#   "occurred_at":"2026-10-31T11:23:22.328Z","instance_type":"server","instance_id":"backend-01",
#   "load_1min":2.79,"load_5min":3.1,"load_15min":2.86,
#   "rendered":"Server backend-01 — CPU: 2.79, 3.1, 2.86"}, …],"next_cursor":null,"total":8}}
```

`GET /memento/healthz` (the UDC plugin's own liveness, no key) answers `{"ok":true}`.
Embedding the plugin: `mementoPlugin`'s `udc` option takes your own `CollectionRegistry`, or
`false` to serve none.

## `GET /memento/api/demo`

No key. The deployment's read-only demo key (`MEMENTO_DEMO_API_KEY`), which the examples site
connects with when the visitor has not pasted a key of their own; `cache-control: no-store`.

```bash
curl -s localhost:3000/memento/api/demo
# {"ok":true,"data":{"api_key":"mk_…","tenant":"demo"}}
```

`404 {"ok":false,"error":{"code":"not_found",…}}` when the server has no demo key. The server
does not start with a demo key that is unknown, revoked or has any scope besides `read`, so this
route never hands out a key that can write.

## `GET /memento/api/health`

No key. `200 {"ok":true,"data":{"status":"ok"}}` when the server can reach PostgreSQL.
