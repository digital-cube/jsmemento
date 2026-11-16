# JSMemento — Architecture

> Implemented: the core API and multitenancy, Handlebars templates with locale fallback and
> YAML/CSV lookups ([TEMPLATES.md](TEMPLATES.md)), chats as first-class instances
> ([CHATS.md](CHATS.md)), WebSocket streaming `/memento/ws` (in one process, or across processes over Redis Pub/Sub;
> [STREAMING.md](STREAMING.md)), the `@memento/react` UI and the CLI ([REACT.md](REACT.md),
> [CLI.md](CLI.md)), UDC collections (`packages/server/src/udc/`, [API.md](API.md#post-mementoudcaction--udc-collections))
> and self-service accounts ([API.md](API.md#accounts-memento_accountstrue)). Per-event seen/star
> endpoints come later; their tables already exist.

Background and design rationale: [ANALYSIS.md](ANALYSIS.md), [PHILOSOPHY.md](PHILOSOPHY.md).
Endpoint reference: [API.md](API.md).

## 1. Repository layout

```
jsmemento/
├── pnpm-workspace.yaml        # packages/* and apps/*
├── turbo.json                 # build / typecheck / test / test:cov pipelines
├── tsconfig.base.json         # strict TS, NodeNext, custom condition "@memento/source"
├── biome.json                 # lint + format
├── compose.yaml               # PostgreSQL 18 + Redis 7 (+ creates <db>_test)
├── .env.example               # every variable the server and CLI read
├── lookups.yaml               # vocabulary: EventTypes, InstanceTypes, ActorTypes
├── i18n/translations.csv      # lookup labels per locale
├── var/candidates/            # unknown lookup values recorded at ingestion
├── packages/
│   ├── core/    @memento/core    Zod schemas, inferred types, helpers (only dep: zod)
│   ├── lookups/ @memento/lookups YAML vocabulary, CSV translations, candidates, codegen
│   ├── server/  @memento/server  Fastify plugin + app, Drizzle schema & migrations,
│   │                             Handlebars renderer + bundled templates (templates/*.hbs)
│   ├── cli/     @memento/cli     `memento` command (Commander, chalk, ora, @inquirer/prompts)
│   └── react/   @memento/react   React components + hooks over the HTTP API and /ws
└── apps/
    └── example/ @memento/example Vite + React demo (proxies /memento to the server)
```

Dependency direction: `cli → server → core`, `react → core`, `server → lookups` (`lookups` depends only on `yaml`). `core` has no Node-only APIs (it hashes with
Web Crypto), so the same package serves browsers, React and the future client SDK.

Packages export `dist/` for consumers, plus a `@memento/source` export condition pointing
at `src/` — `tsx` (dev server, CLI in dev) and `tsc --noEmit` resolve workspace packages
from source, so no build step is needed during development. Vitest uses path aliases for
the same purpose.

## 2. `@memento/core` — the protocol

| Module | Contents |
|--------|----------|
| `common.ts` | `EventTypeSchema` (`SCREAMING_SNAKE_CASE`), `InstanceTypeSchema` (`snake_case`), `InstanceIdSchema` / `ActorIdSchema` (string or integer → string, 1–200 chars), `SlugSchema`, `TimestampSchema` (ISO-8601 with offset) |
| `event.ts` | `EventInputSchema` (what producers push; strict — unknown fields are rejected), `EventSchema` (stored event), `EntityRefSchema` |
| `tenant.ts`, `apikey.ts`, `user.ts`, `interactions.ts` (Seen, Star), `template.ts`, `chat.ts` | Entity schemas |
| `scopes.ts` | `SCOPES = read, write, admin`; `hasScope()` (admin implies all), `parseScopes()` |
| `apikey.ts` | `generateApiKey()`, `parseApiKey()`, `hashApiKey()` (SHA-256), `timingSafeEqual()`, `extractApiKey()` |
| `envelope.ts` | `{ ok: true, data, meta? }` / `{ ok: false, error: { code, message, details? }, request_id }`, `ERROR_CODES` → HTTP status |
| `filter.ts` | Filter DSL (below), `matchCondition()` for `*` wildcards |
| `query.ts` | `EventQuerySchema` (GET query string), `eventQueryToFilter()`, keyset cursor encode/decode |
| `view.ts` | `ViewConfigSchema`, `DEFAULT_EVENT_VIEW` (columns, default sort, page size) |
| `describe.ts` | `buildDescribe()` — the `/describe` document incl. JSON Schemas generated from Zod |
| `template.ts` | `LocaleSchema`, `TemplateSchema`, `TemplateInputSchema`, `GENERIC_TEMPLATE` (`_generic`), `FREE_TEXT_EVENT_TYPES` (`NOTE`) |
| `stream.ts` | WebSocket protocol: `StreamFilterSchema` + `matchesStreamFilter()`, `StreamMessageSchema` (`memento.welcome` / `memento.event.new` / `memento.pong` / `memento.error`), `streamSubprotocols()` / `extractSubprotocolKey()` (`bearer.<key>`), `STREAM_CLOSE_CODES` |
| `lookups.generated.ts` | generated from `lookups.yaml`: `EVENT_TYPES` / `EventType` enum / `KnownEventTypeSchema` (`z.enum`), same for instance and actor types |

Every type is inferred from its schema (`z.infer`), so server, CLI and clients cannot drift.

### Filter DSL

The query language of `POST /memento/events/query`: a tree of conditions on an event's fields,
combined with `and`, `or` and `not`.

```ts
type Filter =
  | { field: FilterField; op: "eq"|"ne"|"lt"|"lte"|"gt"|"gte"|"prefix"|"contains"; value: scalar }
  | { field: FilterField; op: "in"|"nin"; value: scalar[] }
  | { field: FilterField; op: "between"; value: [scalar, scalar] }
  | { field: FilterField; op: "is_null"; value: boolean }
  | { and: Filter[] } | { or: Filter[] } | { not: Filter };

FilterField = event_type | instance_type | instance_id | actor_id | occurred_at | received_at
```

`payload` is deliberately not filterable. The server compiles the tree to SQL
(`packages/server/src/db/filter.ts`); `prefix`/`contains` escape `%`, `_` and `\`, so
`CHAT_*` matches a literal underscore.

## 3. Database schema (PostgreSQL or SQLite, Drizzle)

The server runs on PostgreSQL (the default, any number of processes) or on a SQLite file (one
server process on one host, no Redis needed); `DATABASE_URL`'s scheme picks it
(`postgres(ql)://` or `file:<path>` / `file:///abs/path` / `:memory:`). A process speaks one
dialect: the first `connect` decides it. How to run on SQLite, and what it cannot do:
[SQLITE.md](SQLITE.md).

Source of truth: `packages/server/src/db/schema-postgres.ts`, and its twin
`db/schema-sqlite.ts` (the same tables, columns, CHECKs, unique and partial indexes, and a
type-level check that its rows equal the PostgreSQL rows). The services import
`db/schema.ts`, which hands out the tables of the connected dialect (live ES bindings: read a
column when a query is built, never into a module-level constant). Migrations are generated
by `pnpm db:generate` (drizzle-kit, both sets) into `packages/server/drizzle/` (PostgreSQL)
and `packages/server/drizzle-sqlite/` (SQLite); `runMigrations()` and `memento migrate` apply
the set of the connected dialect, and both ship in the package:

- `0000_init.sql` — all tables and indexes (generated); PostgreSQL then evolved through
  `0002`–`0005`, SQLite starts from the current schema
- `0001_event_immutability.sql` — custom: the immutability trigger(s) on `memento_event`

All ids are UUIDs generated by the application as UUID v7 (`db/uuid.ts`, time-ordered):
`uuid` on PostgreSQL (`gen_random_uuid()` stays the column default for rows inserted by
hand), lower-case TEXT on SQLite (ordered the same: lower-case hex compares as the 128 bits
do). Timestamps are `timestamptz` on PostgreSQL and INTEGER epoch milliseconds on SQLite,
`Date` in TypeScript either way; `jsonb` and `text[]` are JSON TEXT on SQLite, booleans 0/1,
`date` columns `YYYY-MM-DD` TEXT.

What is not portable SQL goes through the dialect seam (`db/dialect.ts`; `db/postgres.ts`
and `db/sqlite.ts`): error classification, casts, JSON members (`payloadNumber`), `like` /
`ilike`, the time expressions (minute buckets, the UTC hour of a usage row, `later`), null-safe
comparison, nulls-last ordering. Nothing outside `db/` imports a driver or a drizzle dialect
module, and no service branches on the dialect. `test/parity.test.ts` runs on both and pins the
answers they must share character for character.

**SQLite driver.** Node's built-in `node:sqlite` under drizzle's `sqlite-proxy` driver — no
native dependency (drizzle 0.45 has no `node:sqlite` driver, and its `better-sqlite3` driver
refuses the async transaction callbacks the services use). `db/sqlite.ts` opens one writer
connection (WAL, `foreign_keys = ON`, `synchronous = normal`) and one read-only connection:
every transaction is `BEGIN IMMEDIATE` behind an in-process FIFO gate, so writes take turns in
arrival order; a statement outside a transaction is its own turn; a nested `db.transaction`
is a savepoint; a SELECT outside a transaction goes to the reader and does not wait. Another
process holding the file's write lock (a `memento` CLI command) is waited for on a timer, up
to 10 s, without stopping the event loop. `LIKE` is case-sensitive with `\` escapes, as on
PostgreSQL; `ilike` folds every letter (a JavaScript `toLowerCase` function), not ASCII only.
The background work of the one process — the usage meter flush (one upsert per batch), the
retention UPDATE batches, the session purge — is single statements through the gate; no
transaction is ever held across a network call (password hashing runs before, mail and
publish after the commit).

### `memento_tenant`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| slug | varchar(63) UNIQUE | `^[a-z0-9]+(-[a-z0-9]+)*$` |
| name | varchar(200) | |
| is_active | boolean, default true | keys of an inactive tenant fail auth |
| created_at | timestamptz | |

### `memento_apikey`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid → tenant (cascade) | the key's tenant binding |
| name | varchar(200) | what the key is for |
| prefix | varchar(16) UNIQUE | the 8 chars after `mk_`, stored in clear to find the row |
| key_hash | varchar(64) | SHA-256 hex of the full key — the key itself is never stored |
| scopes | text[] | subset of `read`, `write`, `admin` |
| created_at, last_used_at, expires_at, revoked_at | timestamptz | `last_used_at` updated on every auth |

Key format: `mk_<8 × [a-z0-9]>_<32 × [A-Za-z0-9]>` (≈190 bits of secret).

### `memento_event` — the immutable log
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid → tenant (restrict) | |
| occurred_at | timestamptz(3) | producer time; defaults to receive time |
| received_at | timestamptz(3), default now() | |
| event_type | varchar(100) | `USER_LOGIN` |
| instance_type | varchar(64) | `user`, `ticket`, `chat` |
| instance_id | varchar(200) | |
| actor_id | varchar(200) NULL | |
| payload | jsonb, default `{}` | |
| rendered | text NULL | rendered at push from the templates, or sent pre-rendered |
| rendered_locale | varchar(35) NULL | locale of `rendered`; NULL = verbatim (pre-rendered or `NOTE`) — migration `0002` |
| archived_at | timestamptz NULL | soft delete |

Indexes (all lead with `tenant_id`): `(tenant_id, occurred_at desc, id desc)` for the feed
and keyset pagination; `(tenant_id, instance_type, instance_id, occurred_at desc)` for
entity history; `(tenant_id, event_type, occurred_at desc)`; partial
`(tenant_id, actor_id, occurred_at desc) WHERE actor_id IS NOT NULL`.

Timestamps use millisecond precision on purpose: JavaScript `Date` cannot carry
microseconds, and a cursor that lost precision would skip or repeat rows.

**Immutability is enforced by the database**: trigger `memento_event_immutable` rejects
every `DELETE`, and every `UPDATE` except setting `archived_at` once from `NULL`.
(`TRUNCATE` is not a row operation; the test suites use it.) On SQLite the same rule is two
triggers, `memento_event_no_delete` and `memento_event_archive_only` (which names every column:
a column added to `memento_event` must be added to it too); the SQLite test reset drops and
recreates them around its `DELETE`s.

### `memento_seen`, `memento_star`
`(event_id, user_id)` primary key, `tenant_id` + `(tenant_id, user_id)` index;
`seen_at` / `starred_at`, `memento_star.note`. Endpoints arrive with Phase 4b.

### `memento_template`
`tenant_id, event_type, locale, body, created_at, updated_at`, unique
`(tenant_id, event_type, locale)`. A tenant's Handlebars template for an event type (or
`_generic`); beats the bundled template at the same locale step. See [TEMPLATES.md](TEMPLATES.md).

### `memento_chat`, `memento_chat_participant`
`memento_chat`: `tenant_id, instance_id ("chat-<id>"), kind ('direct' | 'room'), name,
created_at, last_message_at, archived_at`, unique `(tenant_id, instance_id)`.
`memento_chat_participant`: `tenant_id, chat_id, user_id, added_at, last_seen_event_id,
last_seen_at`, primary key `(chat_id, user_id)`, index `(tenant_id, user_id)`. A chat is an
instance with `instance_type = "chat"`; its messages, read markers and joins are ordinary
events (`CHAT_MESSAGE_SENT`, `CHAT_MESSAGE_SEEN`, `CHAT_PARTICIPANT_ADDED`). Migration 0003
moved the old `participants text[]` into the participant table and renamed `title` → `name`.
See [CHATS.md](CHATS.md).

## 4. `@memento/server`

```
src/
├── app.ts            mementoPlugin (encapsulated Fastify plugin) + buildApp (standalone)
├── auth.ts           API key auth hooks + tenant context
├── context.ts        AsyncLocalStorage tenant context: runWithTenant / requireTenant
├── errors.ts         MementoError(code, message, details) → envelope + HTTP status
├── publisher.ts      EventPublisher: RedisPublisher | MemoryPublisher | NoopPublisher
├── stream/           feed.ts (EventFeed: RedisFeed | LocalBus), hub.ts (StreamHub fan-out,
│                     StreamConnection: buffer limit, heartbeat)
├── config.ts         loadConfig() from env (.env.example)
├── lookups.ts        initLookups (YAML + translations + candidate recorder), strict check
├── templates/        engine.ts (sandboxed Handlebars + helpers), renderer.ts (locale chain,
│                     tenant overrides, bundled templates from ../templates/*.hbs)
├── db/               schema.ts, index.ts (connect by URL scheme, runMigrations), dialect.ts
│                     + postgres.ts (the dialect seam), uuid.ts (v7), filter.ts (DSL → SQL)
├── services/         tenants.ts, apikeys.ts, events.ts, templates.ts — all business logic
├── routes/           health, events, entities, chats, describe, stream (/ws) — thin adapters
├── server.ts         standalone entry (migrates, listens, graceful shutdown)
└── migrate-cli.ts    `pnpm db:migrate`
```

### Request lifecycle

```
request
  │  genReqId: accept a sane X-Request-Id, else UUID → logged as request_id, echoed back
  ▼
onRequest (auth.ts) — only for routes with config.scope
  │  key from "Authorization: Bearer mk_…" or "X-Api-Key"
  │  prefix lookup → SHA-256 compare (constant time) → not revoked / expired / tenant active
  │  401 unauthorized (one message for every failure) | 403 forbidden (scope missing)
  │  request.tenant = { tenantId, tenantSlug, tenantName, apiKeyId, scopes }
  │  request.log = child logger { tenant, api_key }
  ▼
preHandler — runWithTenant(request.tenant, …)   (AsyncLocalStorage ≈ Python ContextVar)
  ▼
route handler → service
  │  services call requireTenant(); the tenant id NEVER comes from the request body/query,
  │  and every query has WHERE tenant_id = <context tenant>
  ▼
envelope { ok: true, data, meta? }      or error handler → { ok: false, error, request_id }
```

Multitenancy is enforced in the service layer, not in routes: a service called outside a
tenant context throws `unauthorized`, so a new route cannot accidentally run unscoped.

### Event push

`POST /memento/events` → `EventInputSchema` → (strict lookups check) → render `rendered`
in `?locale` unless the producer sent it → `INSERT … RETURNING` → publish to Redis
channel `memento:events:<tenant_slug>` (JSON of the stored event) → record unknown lookup
values as candidates → `201`. Publishing is
best effort: the event is already durable, a Redis failure is logged as a warning and does
not fail the request. With no `REDIS_URL` the standalone server uses a `LocalBus` (in-memory
publisher that feeds the WebSocket hub directly).

### Real-time stream

`GET /ws` (WebSocket) → `onRequest` auth (the key may also come as subprotocol
`bearer.<key>`) → `preValidation` parses the filter → upgrade → `StreamHub.add`: the first
connection of a tenant subscribes the feed — `RedisFeed` on `memento:events:<tenant_slug>`, or
the `LocalBus` without Redis — → welcome.
Each message from the feed is dispatched in order to the tenant's connections whose filter
matches (re-rendered once per `?locale`). Per connection, messages not yet flushed to the
socket are counted; at 1000 the client is closed (`4008`) as a slow consumer. One 30 s
interval pings every connection and terminates those that missed the previous pong. Details:
[STREAMING.md](STREAMING.md).

### Queries and pagination

`GET /memento/events` turns the query string into a Filter (`eventQueryToFilter`), ANDs
`tenant_id = …` and `archived_at IS NULL` (unless `include_archived`), and pages with a
keyset cursor over `(occurred_at, id)` — stable under concurrent inserts, no `OFFSET` scans.
`next_cursor` is `null` on the last page. With `?locale=` the page's events whose stored
text is in another locale (or missing) are rendered in one batch — one query loads the
tenant's templates for the page's event types.

### Error handling

| code | HTTP | when |
|---|---|---|
| `bad_request` | 400 / 413 | malformed JSON, bad cursor, body too large |
| `unauthorized` | 401 | missing / invalid / revoked / expired key, inactive tenant; no / expired session (`config.auth`) |
| `forbidden` | 403 | key lacks the route's scope; `admin` session route for a non-admin |
| `not_found` | 404 | unknown route, unknown tenant |
| `conflict` | 409 | duplicate tenant slug, duplicate template without `--replace` |
| `unsupported_media_type` | 415 | unsupported content type; a cookie write without `application/json` |
| `validation_error` | 422 | Zod validation failed (`details` = Zod issues) |
| `rate_limited` | 429 | `/auth/*` rate limits |
| `internal_error` | 500 | anything unexpected (logged with stack, message hidden) |

### Deployment modes

- **Embedded**: `app.register(mementoPlugin, { prefix: "/memento", db, publisher, stream })`
  in your own Fastify app (the plugin is encapsulated: its error handler and auth hooks do not
  leak). `stream: { feed }` enables `/ws`.
- **Standalone**: `node packages/server/dist/server.js` (or `pnpm dev`) — applies migrations on
  start, then listens on `HOST:PORT`.

## 5. `@memento/cli`

`memento [--json] <command>`; reads `DATABASE_URL`.

| command | what it does |
|---|---|
| `migrate` | apply pending migrations |
| `create-tenant <slug> --name <name>` | create a tenant |
| `list-tenants` | list tenants |
| `create-key --tenant <slug> --scopes read,write --name <name> [--expires-in-days N]` | create a key; prints the plaintext once |
| `revoke-key <prefix>` | revoke a key |
| `create-template --tenant --event-type --locale (--body \| --file) [--replace]` | write a tenant template into `memento_template` (compiled first) |
| `list-templates --tenant` / `delete-template --tenant --event-type --locale` | manage tenant templates |
| `lookups validate [--path] [--translations]` | check `lookups.yaml` + translations CSV (`file:line` errors/warnings) |
| `lookups codegen [--path] [--out] [--check]` | regenerate `@memento/core`'s typed lookups; `--check` fails when stale |
| `lookups candidates [--path] [--dir]` | list recorded unknown values |
| `create-chat --tenant --participants a,b [--name] [--kind] [--chat-id]` | create a chat (`--tenant` defaults to `$MEMENTO_TENANT`) |
| `send-message --tenant --chat-id --user --content [--locale]` | send a chat message as a participant (rendered, published to Redis when `REDIS_URL` is set) |

Exit codes: `0` ok, `1` domain/validation error (`error: …` on stderr), commander's code for
usage errors.

## 6. Testing

Vitest per package, run by Turbo (`pnpm test`, `pnpm test:cov`). Server and CLI suites run
twice, as two vitest projects: against a real PostgreSQL test database (`TEST_DATABASE_URL`),
migrated once per run and truncated per test file, and against a SQLite file under the
temporary directory, created and migrated for the run, with `REDIS_URL` empty
(`MEMENTO_TEST_DIALECT=postgres|sqlite`, or `test:pg` / `test:sqlite` in the package, runs
one). Turbo orders `@memento/cli#test` after `@memento/server#test` so they never truncate
each other's data. `test/sqlite.test.ts` (SQLite only) covers the connection, the
migrations, the writer gate and another process on the file; `test/parity.test.ts` (both)
pins the answers the two databases share. A test that cannot run on SQLite is skipped by name
(`it.skipIf(onSqlite)`, the reason in a comment): the Redis publisher, quota-counter and
stream tests, and the PostgreSQL spelling of the dialect seam (`test/dialect.test.ts`, whose
SQLite twins are in `test/sqlite.test.ts`). The Redis publisher test and the Redis stream test
(`RedisPublisher` → `RedisFeed` → WebSocket clients) use `REDIS_URL` (default
`redis://localhost:6379/0`) and are skipped with a warning when Redis is unreachable. The
stream suites: `test/stream-hub.test.ts` (hub with fake sockets: filters, tenant isolation,
slow consumer, heartbeat) and `test/stream.test.ts` (real server + `ws` clients).
Coverage thresholds: 80 % lines / statements / functions / branches in every package.
