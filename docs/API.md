# HTTP API

Every route `@memento/server` serves, with the scope it needs, its parameters and its answers.
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

The `/auth/*` routes and session collections take a **session cookie** instead, never a key
(and key routes never take the cookie): see [Accounts](#accounts-memento_accountstrue).

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
| `bad_request` | 400 (also 413 for body size) |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `limit_reached` | 409 — `POST /keys` when the tenant holds `max_keys` live keys (`details: {max_keys}`) |
| `unsupported_media_type` | 415 — a cookie-authenticated write without `Content-Type: application/json` |
| `validation_error` | 422 — `details` lists the Zod issues (`path`, `message`, …) |
| `rate_limited` | 429 — `/auth/*` rate limits |
| `quota_exceeded` | 429 — the API key wrote its daily limit of events (`details: {limit, used, resets_at}`), [below](#daily-limits-and-usage) |
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
    "archived_at": null,
    "api_key_id": "6f1c0e2a-…"
  }
}
```

`api_key_id` is the id of the API key that wrote the event — `null` for events written by a
signed-in user (the `APIKEY_*` lifecycle events) or by the CLI, and for events stored before
1.1. It is set on insert and never changes. The UDC `events` collection shows it as `api_key`:
the key's **prefix** (`mk_<prefix>_…`), which is what a person recognizes, filterable
(`{"field":"api_key","op":"eq","value":"ab12cd34"}`), not sortable.

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
| `activity` | the tenant's live events **counted per minute and per `event_type`**, computed per request (`date_trunc('minute', occurred_at)`, `GROUP BY`): `minute` (datetime), `event_type`, `count` (integer), then one integer per event type of `lookups.yaml` (`cpu_load`, `ticket_created`, …) and `other` for types outside it — the bucket's `count` under its own type, 0 elsewhere (the chart's series). Covers the last 60 minutes unless the filter names `minute` (`{"field":"minute","op":"gte","value":"…"}` widens or narrows it); `total` = number of buckets; row id `<minute ISO>\|<event_type>`. Chart (default, a line per type) + table |
| `menu` | the examples site's sidebar: `menu.yaml` (`MEMENTO_MENU_PATH`) as flat tree rows (`code`, `translation_key`, `icon`, `url`, `parent_id`, `order`, `depth`, `ancestor_ids`, `children_count`, `is_dynamic`), `source_kind: yaml_menu`. Its `udc:collections` branch lists every collection served, this one included. Not tenant data: the same for every key. Only when the file exists. With accounts on it is `key_or_session`: a request without a key may read it with the session cookie (the service site's sidebar, `menu-service.yaml`); writes still need a key. |

Actions: `collections`, `describe`, `list` (filter DSL, sort, offset paging, exact `total`),
`read`. A collection registered with `auth: "session" | "admin"` (`MementoRegistry`, see
[Accounts](#session-collections)) takes the session cookie instead of a key. Every collection is read-only — events are immutable, push them with
`POST /memento/events`; `mutate` and the schema edits answer `unsupported_op`. A sort on a text
field compares Unicode code points (`COLLATE "C"` on PostgreSQL, `BINARY` on SQLite), so the
order is the same on every database whatever its collation: `USER_LOGIN` before `_generic`,
upper case before lower case.

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

Events per minute for the last 15 minutes, CPU samples left out:

```bash
curl -s localhost:8000/memento/udc/list -H "Authorization: Bearer mk_…" \
  -H 'content-type: application/json' \
  -d '{"collection":"activity","filter":{"and":[
         {"field":"minute","op":"gte","value":"2026-10-31T11:10:00Z"},
         {"field":"event_type","op":"neq","value":"CPU_LOAD"}]},"page":{"limit":2}}'
# {"kind":"udc.list.ok","id":"","payload":{"rows":[{"__meta":{"id":"2026-10-31T11:24:00.000Z|TICKET_CREATED",
#   "version":1},"minute":"2026-10-31T11:24:00.000Z","event_type":"TICKET_CREATED","count":3,
#   "user_login":0,…,"ticket_created":3,…,"other":0}, …],"next_cursor":null,"total":41}}
```

`GET /memento/healthz` (the UDC plugin's own liveness, no key) answers `{"ok":true}`.
Embedding the plugin: `mementoPlugin`'s `udc` option takes your own `CollectionRegistry`, or
`false` to serve none. Built with `@jsudc/*` 0.3, like memento's own. At startup
`@jsudc/server` checks every `lookup` field and `row_link` of the registry against the
collections it serves, and a lookup into a collection that is not served stops the start
(memento's collections have neither).

## Accounts (`MEMENTO_ACCOUNTS=true`)

Self-service users for the service site: anyone registers, gets a **tenant** of their own and
is its first **user** (`owner`; the membership table allows more users per tenant later).
With `MEMENTO_ACCOUNTS` off (the default, and the examples instance) none of these routes
exist (404) and no request is ever authenticated by a cookie.

### The session credential

- Cookie `memento_session`: 32 random bytes, base64url. The server stores only its SHA-256
  (`memento_session.id`). `HttpOnly; SameSite=Lax; Path=/; Max-Age=<MEMENTO_SESSION_DAYS>`,
  `Secure` when the request is https (`X-Forwarded-Proto` counts with `MEMENTO_TRUST_PROXY`).
- **Sliding:** a session last seen more than 60 s ago gets `last_seen_at` and `expires_at`
  pushed out (`now + MEMENTO_SESSION_DAYS`) and the cookie is re-sent with a fresh `Max-Age`.
- A route declares `config.auth: "session" | "admin"` next to `config.scope`. No / unknown /
  expired cookie → `401 unauthorized` (and the cookie is cleared); a disabled user → `401`
  and the session row is deleted; `admin` for a user without `is_admin` → `403 forbidden`.
  The tenant context is the session's tenant with `scopes: ["admin"]`, `apiKeyId: null`,
  plus `userId`, `userEmail`, `isAdmin` — `requireTenant()` works unchanged.
- **Credentials never cross:** a `config.scope` route ignores the cookie (`401 missing API
  key`), a `config.auth` route ignores `Authorization` / `X-Api-Key`.
- **CSRF:** every mutating cookie route (and every `/auth/*` POST) needs
  `Content-Type: application/json` — an HTML form cannot send it — else `415
  unsupported_media_type`. A body may be empty under that content type (`logout`, `resend`).

### Routes

All JSON, the usual envelope. Rate limited (`429 rate_limited`): `register`, `login`,
`forgot`, `resend`, `reset` 10 per client IP per 15 min each; `login` also 10 per email per
15 min. Counters live in Redis when `REDIS_URL` is set (shared by every process), in memory
otherwise. The client IP is the socket's, or `X-Forwarded-For` with `MEMENTO_TRUST_PROXY=true`.

| route | credential | body | answer |
|---|---|---|---|
| `POST /auth/register` | — | `{email, password, name, locale?, terms: true}` | `201 {user, tenant}`, sets the cookie, sends the verify mail. `422` bad email / password < 10 / empty name / `terms` not `true` / locale not `en`·`sr`; `409 conflict "email already registered"` |
| `POST /auth/verify` | — | `{token}` | `200 {user}`; `404` unknown, used or expired token |
| `POST /auth/resend` | session | — | `200 {sent}` always; a new verify mail while the address is unverified |
| `POST /auth/login` | — | `{email, password}` | `200 {user, tenant}`, sets a new cookie; `401 "invalid email or password"` for an unknown email, a wrong password and a disabled user alike |
| `POST /auth/logout` | session | — | `204`; deletes the session row, clears the cookie |
| `POST /auth/forgot` | — | `{email}` | `200 {sent: true}` always; a reset mail only when the user exists and is not disabled (older unused reset links of the user die) |
| `POST /auth/reset` | — | `{token, password}` | `200 {user}`; sets the password, uses the token up, deletes **every** session of the user; `404` bad token, `422` short password |
| `GET /auth/me` | session | — | `{user, tenant, limits}` (below) |
| `PATCH /auth/me` | session | `{name?, locale?, password?: {current, next}}` | `200 {user}`; a wrong `password.current` → `422` |

```json
{
  "user": { "id": "…", "email": "ana@example.com", "name": "Ana", "locale": "en",
            "email_verified": false, "is_admin": false, "created_at": "2026-11-01T08:00:00.000Z" },
  "tenant": { "id": "…", "slug": "t-k6xdzysv", "name": "Ana", "plan": "free",
              "max_keys": null, "retention_days": null },
  "limits": { "default_max_keys": 10, "default_daily_limit": 100000, "max_daily_limit": null }
}
```

Registration runs in one transaction: the user (email trimmed and lower-cased, password
argon2id), the tenant (`slug` = `t-` + 8 random base32 characters, `name` = the user's name),
the `owner` membership, a `verify` token and the session. Mail tokens are 32 random bytes
base64url, stored as SHA-256, single use: `verify` 24 h (`<MEMENTO_SERVICE_URL>/verify/<token>`),
`reset` 1 h (`<MEMENTO_SERVICE_URL>/reset/<token>`). Mails (`packages/server/mail/<kind>.<locale>.hbs`,
first line the subject) go out in the user's locale through Brevo, or are logged without a
Brevo key; a failed delivery never fails the request.

```bash
curl -si localhost:8000/memento/auth/register -H 'content-type: application/json' \
  -d '{"email":"ana@example.com","password":"correct horse battery","name":"Ana","terms":true}' \
  -c jar.txt
curl -s localhost:8000/memento/auth/me -b jar.txt
```

### Session collections

A UDC collection registered in memento's `MementoRegistry` with `auth: "session"` (or
`"admin"`) is read with the cookie — the request needs `Content-Type: application/json` — and
answers a key with an in-protocol `forbidden`; its source reads the session's tenant from
`requireTenant()` like any other. Without `MEMENTO_ACCOUNTS` such a collection refuses
everyone.

```ts
const registry = eventCollections({ db });
registry.register({ name: "my_keys", source, view, auth: "session" });
```

### API keys (`/keys`, session)

The signed-in user's keys, always of the session's tenant; an API key as credential is `401`,
a key of another tenant (or a deleted one) `404`. Listing is the `api_keys` collection below.
Writes need `Content-Type: application/json` (an empty body is `{}`).

| route | body | answer |
|---|---|---|
| `POST /keys` | `{name, scopes: ("read"\|"write")[] (non-empty), expires_at?, daily_limit?}` | `201 {api_key, key}` — `key` is the plaintext `mk_…`, returned **this once** and never logged; `409 limit_reached` with `{max_keys}` when the tenant holds `max_keys ?? MEMENTO_DEFAULT_MAX_KEYS` live (not deleted, not revoked) keys |
| `PATCH /keys/:id` | `{name?, daily_limit?}` | `200 {api_key}`; `daily_limit` ≥ 1 and ≤ `MEMENTO_MAX_DAILY_LIMIT` when set (else `422`), `null` → the default |
| `POST /keys/:id/disable` | — | `200 {api_key}` with `status: "disabled"`: paused, fails auth like a revoked key |
| `POST /keys/:id/enable` | — | `200 {api_key}`: resumed |
| `DELETE /keys/:id` | — | `204`: soft delete — fails auth, hidden from every list; the row stays because events point at it |

`admin` is not a scope a user can give a key (the CLI still can). The key as these routes
return it (`ApiKey` in `@memento/core`):

```json
{
  "id": "6f1c0e2a-…", "tenant_id": "…", "name": "backend", "prefix": "ab12cd34",
  "scopes": ["read", "write"], "created_at": "…", "last_used_at": null, "expires_at": null,
  "revoked_at": null, "status": "active", "daily_limit": 100000, "used_today": 0,
  "created_by": "<user id>"
}
```

`status`: `revoked` (CLI `revoke-key`) > `expired` > `disabled` > `active`. `daily_limit` is
the key's own limit, else `MEMENTO_DEFAULT_DAILY_LIMIT`. `created_by` is `null` for CLI keys.

**Lifecycle events.** Each change writes an event into the key's tenant (through the same path
as `POST /events`, so it is rendered, published and streamed): `event_type`
`APIKEY_CREATED` · `APIKEY_DISABLED` · `APIKEY_ENABLED` · `APIKEY_DELETED` ·
`APIKEY_LIMIT_CHANGED`, `instance_type: "api_key"`, `instance_id` the key's prefix, `actor_id`
the user's email, `payload: {name, scopes}` (plus `{daily_limit, previous}` for the limit;
`null` = the default), `api_key_id: null`. Disabling an already disabled key writes nothing.
The CLI's `create-key` / `revoke-key` write none.

### Daily limits and usage

With accounts on, every API key is held to a number of **events per UTC day**: its
`daily_limit`, else `MEMENTO_DEFAULT_DAILY_LIMIT`. Every route that stores an event with a key
— `POST /events`, `POST /chats/:id/messages`, `/seen`, `/participants` — checks it first:

- `used + 1 > limit` → `429 quota_exceeded`, nothing stored:
  ```json
  {"ok":false,"error":{"code":"quota_exceeded","message":"this API key wrote its daily limit of 5 events; it resets at 2026-11-02T00:00:00.000Z","details":{"limit":5,"used":5,"resets_at":"2026-11-02T00:00:00.000Z"}},"request_id":"…"}
  ```
  The first refusal of the day mails `quota_exceeded`;
- `used + 1 ≥ 80 % of limit` → stored, and the first time that day the `quota_warning` mail.

The mails (`packages/server/mail/quota_{warning,exceeded}.{en,sr}.hbs`) go to the user who
created the key, else the tenant's owner, in their locale, with a link to
`${MEMENTO_SERVICE_URL}/keys/<id>`; sending never delays or fails the request. "Once a day" is
claimed atomically on `memento_apikey.quota_warned_on` / `quota_exceeded_on`, so several
processes do not send it twice.

Today's count lives in Redis (`memento:quota:<key id>:<YYYY-MM-DD>`, `INCRBY` per stored event,
`EXPIRE 172800`) when `REDIS_URL` is set; without Redis it is the sum of today's
`memento_apikey_usage.events_written` plus what this process has not flushed yet.

**Usage meter.** Per key and hour (UTC) the server counts `requests` and `bytes_in` (every
API-key request, `Content-Length`), `events_written`, `rows_read` (rows returned by
`GET /events`, `POST /events/query` and UDC `list`) and `stream_seconds` (open `/ws`
connections, every 60 s and on close) — in memory, written to `memento_apikey_usage` every
5 s and on shutdown with one upsert per batch. A failed write is logged and dropped. Session
(cookie) requests are not metered.

### Self-service collections

Registered by memento when accounts are on (`eventCollections({ accounts: { quota } })`), read
with the session cookie and refusing a key (in-protocol `forbidden`):

| collection | auth | rows |
|---|---|---|
| `api_keys` | session | the tenant's keys (not deleted): `name`, `prefix`, `scopes`, `status`, `daily_limit`, `used_today` (Redis or usage), `events_24h` (events in the last 24 h), `created_at`, `last_used_at`, `expires_at`; newest first; row id = key id |
| `api_key_events` | session | the `events` collection (same fields, sort, paging) over events written with a key; **needs** a top-level `eq` / `in` filter on `api_key` (the prefix), else `validation_error` |
| `api_key_history` | session | the `events` collection over the tenant's key lifecycle events (`instance_type = api_key`: `APIKEY_CREATED`, `_DISABLED`, `_ENABLED`, `_LIMIT_CHANGED`, `_DELETED`), written by the signed-in user and so not in `api_key_events`; **needs** a top-level `eq` / `in` filter on `instance_id` (the key's prefix) |
| `api_key_activity` | session | the `activity` collection (per minute and type) over events written with a key, bucketed per key too: extra field `api_key` to filter on; row id `<minute>\|<type>\|<prefix>` |
| `api_key_usage` | session | the tenant's `memento_apikey_usage` rows: `api_key` (prefix), `hour`, `requests`, `events_written`, `rows_read`, `stream_seconds`, `bytes_in`; newest hour first |
| `admin_users` | admin | every user: `email`, `name`, `tenant` (slug of the tenant they own), `tenant_name`, `email_verified`, `is_admin`, `disabled`, `keys` (live keys of their tenant), `created_at` |
| `admin_api_keys` | admin | every key of every tenant: `user` (creator's email, empty for CLI keys), `tenant`, and the `api_keys` fields |

```bash
curl -s localhost:8000/memento/udc/list -b jar.txt -H 'content-type: application/json' \
  -d '{"collection":"api_key_events","filter":{"field":"api_key","op":"eq","value":"ab12cd34"}}'
```

### Administration (`/admin`, admin session)

| route | answer |
|---|---|
| `POST /admin/users/:id/disable` | `200 {user}` (with `disabled: true`); the user cannot sign in and **every session of theirs is deleted**; an admin cannot disable themselves (`409`) |
| `POST /admin/users/:id/enable` | `200 {user}` |
| `POST /admin/keys/:id/disable` | `200 {api_key}`: pauses any tenant's key; writes `APIKEY_DISABLED` into the key's tenant with the admin's email as `actor_id` |
| `POST /admin/keys/:id/enable` | `200 {api_key}`; `APIKEY_ENABLED` likewise |

A signed-in non-admin gets `403 forbidden`, no session `401`.

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
