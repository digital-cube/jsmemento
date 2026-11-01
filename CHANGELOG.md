# Changelog

All notable changes to JSMemento. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@memento/*` package and the Docker image
share one version.

## [Unreleased]

### Added

- **API keys users manage** (`@memento/server`, `MEMENTO_ACCOUNTS`): session routes
  `POST /keys` (`{name, scopes: read|write, expires_at?, daily_limit?}` → the plaintext once;
  `409 limit_reached` past `max_keys`), `PATCH /keys/:id` (name, `daily_limit`),
  `POST /keys/:id/disable|enable` (pause / resume), `DELETE /keys/:id` (soft delete). Disabled
  and deleted keys fail auth like revoked ones; `revoke-key` (CLI) unchanged. Admin routes
  `POST /admin/users/:id/disable|enable` (disabling deletes the user's sessions) and
  `POST /admin/keys/:id/disable|enable`.
- **Lifecycle events**: `APIKEY_CREATED`, `APIKEY_DISABLED`, `APIKEY_ENABLED`,
  `APIKEY_DELETED`, `APIKEY_LIMIT_CHANGED` (instance type `api_key`, instance id the prefix,
  actor the user's email) in `lookups.yaml`, `translations.csv` and EN + SR templates.
- **`api_key_id` on events**: every event stored with a key records it (`EventSchema` gains an
  optional `api_key_id`); the `events` UDC collection gains `api_key` (the prefix, filterable).
- **Daily limits** per key (`daily_limit ?? MEMENTO_DEFAULT_DAILY_LIMIT` events per UTC day):
  `429 quota_exceeded` with `{limit, used, resets_at}`, `quota_warning` (80 %) and
  `quota_exceeded` mails once a day each (EN + SR, via the mailer); counters in Redis
  (`memento:quota:<key>:<day>`) or summed from the usage table.
- **Usage meter** (`UsageMeter`): requests, bytes in, events written, rows read and stream
  seconds per key and hour, flushed to `memento_apikey_usage` every 5 s and on close.
- **Self-service UDC collections**: `api_keys`, `api_key_events`, `api_key_activity`,
  `api_key_usage` (session) and `admin_users`, `admin_api_keys` (admin), on the new
  `TableCollectionSource` (a read-only UDC source over any SQL query).
- **Retention**: `memento retention [--tenant slug] [--dry-run]` archives events older than a
  tenant's `retention_days` in batches of 10 000; a `retention` service (profile `demo`) in
  `docker-compose.yaml` runs it daily.
- Migration `0005_apikey_lifecycle`; error codes `quota_exceeded` (429), `limit_reached` (409);
  `ApiKey` gains `status`, `daily_limit`, `used_today`, `created_by`; compose passes
  `DEFAULT_MAX_KEYS`, `DEFAULT_DAILY_LIMIT`, `MAX_DAILY_LIMIT`.

- **Self-service accounts, server side** (`@memento/server`, behind `MEMENTO_ACCOUNTS`, off by
  default): `POST /auth/register` (a user, a tenant of their own `t-xxxxxxxx`, the `owner`
  membership, a verify mail, a session), `/auth/verify`, `/auth/resend`, `/auth/login`,
  `/auth/logout`, `/auth/forgot`, `/auth/reset`, `GET`/`PATCH /auth/me`. Passwords argon2id
  (`@node-rs/argon2`); single-use mail tokens stored as SHA-256 (verify 24 h, reset 1 h);
  rate limits (`@fastify/rate-limit`, Redis store with `REDIS_URL`) 10 per IP per 15 min,
  login also per email. Migration `0004_accounts`: `memento_user`, `memento_tenant_user`,
  `memento_session`, `memento_user_token`, and `plan` / `max_keys` / `retention_days` on
  `memento_tenant`.
- **The session credential**: cookie `memento_session` (HttpOnly, SameSite=Lax, Secure over
  https, sliding `MEMENTO_SESSION_DAYS`), `config.auth: "session" | "admin"` on routes next
  to `config.scope` — the two never accept each other's credential; cookie writes need
  `Content-Type: application/json` (415 otherwise). `TenantContext` gains `userId`,
  `userEmail`, `isAdmin`; `apiKeyId` is `null` for a session. UDC collections registered in
  the new `MementoRegistry` with `auth: "session" | "admin"` are read with the cookie.
- **Mail** (`@memento/server`): `Mailer`, `BrevoMailer` (Brevo transactional API; a refusal is
  logged, never fails the request), `LogMailer`, `MemoryMailer`; templates
  `packages/server/mail/{verify,reset}.{en,sr}.hbs` (first line the subject) rendered with the
  event templates' Handlebars sandbox.
- **Config**: `MEMENTO_ACCOUNTS`, `MEMENTO_SERVICE_URL`, `MEMENTO_BREVO_API_KEY`,
  `MEMENTO_MAIL_FROM`, `MEMENTO_TRUST_PROXY`, `MEMENTO_SESSION_DAYS`,
  `MEMENTO_DEFAULT_MAX_KEYS`, `MEMENTO_DEFAULT_DAILY_LIMIT`, `MEMENTO_MAX_DAILY_LIMIT`;
  `docker-compose.yaml` passes `ACCOUNTS`, `SERVICE_URL`, `BREVO_API_KEY`, `MAIL_FROM`,
  `TRUST_PROXY`. `buildApp({ trustProxy, accounts })`.
- **CLI** (`@memento/cli`): `list-users`, `make-admin` / `revoke-admin`, `disable-user` /
  `enable-user`, `verify-user`.
- **Error codes** (`@memento/core`): `unsupported_media_type` (415), `rate_limited` (429).

- **`activity` UDC collection** (`@memento/server`): the tenant's events counted per minute and
  per `event_type`, computed per request with a `GROUP BY` over `memento_event` (no migration,
  no new index: the inner query is bounded on `occurred_at` and reads the tenant/time index).
  Fields `minute`, `event_type`, `count`, plus one integer column per event type of
  `lookups.yaml` and `other` (the chart's series). Last 60 minutes unless the filter names
  `minute`; Filter DSL, sort, offset paging, `total` = buckets. Chart (default) + table.
  `EventCollectionSource`'s filter compiler is now `SqlFilterCompiler`, shared by both.
- **Examples site: the Activity chart** (`/examples/chart`, replaces its planned page — the
  last one): `UdcDataView` on `activity`, chart tab first, a window selector (15 min / 1 h /
  6 h / 24 h) that writes the `minute` range into `?f=` and slides with the clock, refreshed
  by the stream at most once per 5 s.
- **Examples site: the Chat page** (`/examples/chat`, replaces its planned page): the
  simulator's demo room in `MementoChat`, read as one participant picked in a selector
  (`?as=`), with seen markers, "X was added" lines in the header's language, a disabled
  composer ("read-only demo key"), live over the WebSocket; an empty state with the compose
  command while the room does not exist.
- **`memento simulate` chat scene** (`@memento/cli`): makes sure `chat-demo-room` exists
  (created with four of the cast, an existing one reused) and plays messages about the
  desk's tickets in English and Serbian, read markers and the odd new member; `--no-chat`
  turns it off. `TicketDesk.nextStep()` returns events and chat calls; `next()` stays the
  event-only story.
- **`MementoChat` `readOnly`, `seenMarkers`, `systemEvents`** (`@memento/react`), with
  `useMementoChat(…, { seen, system })` returning `participants` and `notices`, and the
  helpers `seenMarkers()` / `applyChatEvent()`.
- **`MementoClient.createChat()`, `.listChats()`, `.markSeen()`, `.addParticipant()`** and
  `chatMessages({ event_type })` (`@memento/core`).
- **UDC collections** (`@memento/server`): `POST <prefix>/udc/<action>` serves the tenant's
  events through `@jsudc/server` 0.2.1 — `events` (every event) and `cpu_load` (`CPU_LOAD`
  events with the load averages as columns, table + chart). Filter DSL, sort, offset paging
  and exact totals over SQL, tenant-scoped by the API key (`read`; refused in-protocol with
  `forbidden`). `mementoPlugin({ udc })` takes another `CollectionRegistry`, or `false`.
- **`memento cpu-monitor`** (`@memento/cli`): pushes `os.loadavg()` as `CPU_LOAD` events every
  `--interval` seconds; logs and retries network/server failures, stops on a refused key.
- **`cpu-monitor` service** in `docker-compose.yaml` (compose profile `demo`, off by
  default): runs `memento cpu-monitor` from the same image against `memento:3000`, with
  `restart: unless-stopped`, so the CPU monitor demo stays live across server and host
  restarts. Configured by `CPU_MONITOR_API_KEY` (write scope), `CPU_MONITOR_TENANT`,
  `CPU_MONITOR_INTERVAL` and `CPU_MONITOR_INSTANCE_ID`; see docs/DEPLOYMENT.md "Demo pusher".
- **`memento simulate`** (`@memento/cli`): plays a ticket desk — a cast of six users and a
  `desk-bot` logging in and out, creating, modifying, noting and closing tickets
  (`ticket/T-<n>`), newcomers (`USER_CREATED`) now and then — one event every `--interval`
  seconds (default 3), deterministic from `--seed`, `--once` for one scene. Payloads carry the
  fields the bundled templates read, so every event renders as a sentence. Flags and env like
  `cpu-monitor`.
- **`simulator` service** in `docker-compose.yaml` (profile `demo`): `memento simulate` from the
  same image, key `SIMULATOR_API_KEY` (write; may be the CPU monitor's), `SIMULATOR_TENANT`,
  `SIMULATOR_INTERVAL`; see docs/DEPLOYMENT.md "Demo pusher".
- **`X-Memento-Locale`** on `POST /udc/*` (`@memento/server`): the `events` and `cpu_load`
  rows' `rendered` text in that locale, like `?locale=` of `GET /events`; a malformed value is
  refused in-protocol with `validation_error`.
- **Examples site: the Activity feed** (`/examples/activity`): the tenant's events except
  `CPU_LOAD` as rendered sentences, newest first, infinite paging over the `events` UDC
  collection, refreshed by the stream, in the header's language (EN / SR). **Every example of the
  series** is in `menu.yaml`; the ones not built yet open a "planned" page.
- **`MementoClient.pushEvent()` and `.describe()`** (`@memento/core`).
- **`apps/examples`** (`@memento/examples`, replaces `apps/cpu-monitor`): the examples site,
  served by the server at `/` and `/en/`. A sidebar drawn from the `menu` UDC collection
  (ported from the jsudc example's shell: tree, expand state, en/sr labels), react-router routes
  (`/examples/cpu-monitor`, `/udc/:collection`), and the CPU monitor as its first example —
  `UdcDataView` over `cpu_load`, refreshed by the WebSocket stream, with a live/offline health
  indicator. Connects by itself with the server's demo key; settings (base URL, own key) in the
  header.
- **`menu` UDC collection** (`@memento/server`): `menu.yaml` at the repository root
  (`MEMENTO_MENU_PATH`; image `/app/config/menu.yaml`) served by `@jsudc/server`'s `yaml_menu`
  source, `udc:collections` resolved against the live registry. `mementoPlugin({ menu })`.
- **`GET <prefix>/api/demo`** (`@memento/server`, no auth): the read-only demo key of
  `MEMENTO_DEMO_API_KEY` (compose: `DEMO_API_KEY`) for the examples site; 404 without one. The
  server refuses to start when that key is unknown, revoked or not exactly `read`.
- Vocabulary: event type `CPU_LOAD`, instance type `SERVER`, and the `CPU_LOAD` templates
  (`Server {{instance_id}} — CPU: …`).

### Changed

- The CLI's `send-message` writes with `apiKeyId: null` (was the placeholder `"cli"`): events
  now reference `memento_apikey`, and the CLI uses no key.

- A framework `415` (unsupported content type) now answers with the code
  `unsupported_media_type` instead of `bad_request`; `429` with `rate_limited`.

- **Breaking:** the health check moved from `GET <prefix>/health` to `GET <prefix>/api/health`
  (default `/memento/api/health`), so it sits under the `/api/` path like other API endpoints
  behind a proxy. The image's `memento-healthcheck` probe follows it; external monitors and
  load-balancer probes have to be pointed at the new path.

## [1.0.0] - 2026-10-31

First stable release: a self-hosted, tenant-isolated activity ledger with an HTTP API,
real-time WebSocket streaming, chats, Handlebars rendering, a CLI and React components.

### Added

- **Docker image** `ghcr.io/digital-cube/jsmemento` (Node 24 LTS, non-root): migrates on start,
  then serves on port 3000; bundles the `memento` CLI and a `memento-healthcheck` probe.
- **`docker-compose.yaml`**: production-like stack — memento + PostgreSQL 18 + Redis 7 with
  health checks and named volumes. `compose.yaml` stays the development infrastructure.
- **E2E suite** (`@memento/e2e`, `pnpm test:e2e`): two processes of the built server against
  real PostgreSQL + Redis — push → query → WebSocket stream across processes, chat
  create → send → live delivery + read receipts, tenant isolation (queries, stream, chats).
  Runs against any deployed server with `MEMENTO_E2E_URL`.
- **CI/CD** (GitHub Actions): on every PR lint, type check, unit tests with coverage
  (≥ 80 % per package, HTML report as an artifact), E2E, and the Docker image tested through
  `docker-compose.yaml`; merges to `main` push `:main`/`:edge`/`:sha-…` images to ghcr.io;
  tags `vX.Y.Z` push `:X.Y.Z`, `:X.Y`, `:X`, `:latest`, create the GitHub release and publish
  `@memento/*` to npm.
- `pnpm test:coverage` (alias of `test:cov`) with text, HTML and JSON-summary reports.
- Docs: [DEPLOYMENT.md](docs/DEPLOYMENT.md), [CONTRIBUTING.md](docs/CONTRIBUTING.md).

### Changed

- The standalone server entry is now `packages/server/src/server.ts` → `node dist/server.js`
  (was `main.ts` / `dist/main.js`).
- Packages carry `repository`, `publishConfig.access=public` and `engines` metadata.

### Earlier phases (unreleased 0.x, all part of 1.0.0)

- **Phase 5 — React UI**: `@memento/react` (`MementoProvider`, live `MementoDataView`,
  `MementoChat`, `MementoSearch`, hooks), `MementoClient` and `MementoStream` in
  `@memento/core`, `apps/example`, CLI colours, prompts, `setup` wizard and `memento tail`.
- **Phase 4 — real-time streaming**: `GET /memento/ws` with subprotocol auth, exact filters,
  per-tenant Redis channels, heartbeat, slow-consumer protection (4008).
- **Phase 3 — chats**: chats and messages as memento events (`CHAT_MESSAGE_SENT`, `…_SEEN`,
  `…_PARTICIPANT_ADDED`), participants with read watermarks, permissions, CLI.
- **Phase 2 — templates & lookups**: sandboxed Handlebars rendering with locale fallback,
  tenant template overrides, `lookups.yaml` + CSV translations, candidate recording, codegen.
- **Phase 1 — core API & multitenancy**: pnpm/Turbo monorepo, Zod protocol, Drizzle schema
  with immutable events, API keys with scopes, events / query / entity history / describe.

[Unreleased]: https://github.com/digital-cube/jsmemento/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/digital-cube/jsmemento/releases/tag/v1.0.0
