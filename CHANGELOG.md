# Changelog

All notable changes to JSMemento. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@memento/*` package and the Docker image
share one version.

## [Unreleased]

### Added

- **The website says how fresh it is.** The footer of every page (the home page beside
  "MIT licence.", the docs under Starlight's footer) shows the version, the date of its release
  tag (the `CHANGELOG.md` heading while there is no tag), when the site was built (UTC) and the
  commit; the Packages list and table show when each package's newest version went to npm, and
  that version when it is not the repository's (*not on npm yet* while a package has never been
  published); beside the image, the release tag's date. Read once per build
  (`apps/website/src/build-info.mjs`); the registry never fails the build, and `SITE_NPM=off`
  builds without asking it ([apps/website/README.md](apps/website/README.md#build-info-the-footer-line-and-on-npm)).
  `deploy/website/stage.sh` fetches the tags and rebuilds when a release tag lands on a built
  commit.
- **SQLite as a database option** for installations that must not depend on a database
  service (the first user: a customer's local machine with neither PostgreSQL nor Redis):
  `DATABASE_URL=file:<path>` (or `file:///abs/path`, `:memory:` for tests) instead of
  `postgresql://…`. PostgreSQL stays the default. On SQLite everything works — events,
  queries, rendering, chats, UDC collections with the same answers, the `/ws` stream, accounts,
  quotas, usage, retention, the CLI — with one limit: **one server process on one host** per
  file, so that process serves either the examples site or the service site, not both. Redis
  is optional there as on PostgreSQL and not needed at all: without it the stream runs on the
  in-process bus, the quota counter reads the usage table and the rate limits live in memory;
  with it, still one server process. The guide, from an empty directory to a running server
  (which database fits, the quick start, the image and a Compose file without `postgres` and
  `redis`, embedding, accounts, the CLI next to the server, backups and the limits), is
  [docs/SQLITE.md](docs/SQLITE.md); the README and `docs/DEPLOYMENT.md` link to it.
  - The driver is Node's built-in `node:sqlite` under drizzle's `sqlite-proxy`, no native
    dependency. One writer connection behind an in-process FIFO gate (every transaction
    `BEGIN IMMEDIATE`, a nested one a savepoint), a read-only second connection for reads, WAL,
    `foreign_keys = ON`; another process holding the write lock (a `memento` CLI command next to
    the server) is waited for on a timer, up to 10 s, without stopping the server.
  - Its own migration set, `packages/server/drizzle-sqlite/` (with the event immutability
    triggers), shipped in the package next to `drizzle/`; `pnpm db:generate` writes both, the
    server at start and `memento migrate` apply the set of the URL's database.
  - `DATABASE_URL` / `TEST_DATABASE_URL` accept `file:<path>`, `file:///abs/path` and
    `:memory:`. The tables of `db/schema.ts` are those of the connected database
    (`db/schema-postgres.ts` or `db/schema-sqlite.ts`, the same row types, checked at compile
    time); a process speaks one dialect. New exports: `dialectOf`, `describeDatabase`,
    `SQLITE_MIGRATIONS_FOLDER`.
  - The server and CLI suites run on both databases (vitest projects, `MEMENTO_TEST_DIALECT`,
    `test:pg` / `test:sqlite`); `test/parity.test.ts` pins what both must answer alike.

- **The website** (`apps/website`, `@memento/website`, [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#the-website)):
  Astro + Starlight with memento's own identity (ink and bone, the red thread, Bodoni Moda),
  dark and light, Pagefind search, a home hero (one `USER_LOGIN` and its EN / SR sentence),
  the sidebar Get started / Concepts / Reference / Examples / Clients / Packages (an index each
  for now) and its own 404. `SITE_URL`, `EXAMPLE_URL`, `SERVICE_URL` at build time;
  `starlight-links-validator` fails the build on a broken internal link (CI job *Website
  build*). Served at `stage.memento-service.org` by `deploy/website/stage.sh`
  (build-and-swap, nginx vhost in `deploy/website/nginx/`). Not part of the image.
  The home page below the hero: one event read back every way (entity history, en / sr,
  Filter DSL, a `/ws` frame), the eight examples as real screenshots, the API, four quick
  starts and the packages; **Get started** with Docker, a client and embedded in Node. Its code
  is repository files imported raw (`apps/website/snippets/`, `clients/`): requests and answers
  recorded by `npm run capture`, screenshots by `npm run shots`, the snippets compiled by
  `check:snippets` in `typecheck`.
  The rest of the sidebar: **Concepts** (events and instances, tenants and keys, rendering,
  streaming, chats, UDC collections, accounts and retention, deployment modes), **Reference**
  generated from `docs/` by `npm run gen` (the HTTP API, the Filter DSL, streaming, chats, the
  CLI, the environment variables; not in git, each page naming its file and commit),
  **Examples** (the examples site, one page per example with its screenshot, the service site),
  **Clients** (`clients/` rendered at build time: the READMEs and the programs' sources, a page
  per language) and **Packages** (versions from the workspace, the image tags, which ones you
  install, the changelog generated from this file).

- **The `/clients` page of the service site** (`apps/service`, [docs/CLIENTS.md](docs/CLIENTS.md#the-clients-page-of-the-service-site)):
  public, a tab per language at `/clients/<lang>` (remembered in localStorage), the two
  environment lines with this origin and a `mk_…` placeholder (Copy; the hint links to `/keys`),
  the README's install / variables / run, the source with line numbers, Copy and the manifest as
  a second tab, and **Download `<lang>.zip`**. Built by `vite-plugin-clients.ts` from
  `clients/` at build time: `virtual:clients` (shiki-highlighted HTML, no grammars in the
  browser) and `dist/clients/<lang>.zip` (fflate; without `node_modules`, `target`, `build`).
  Logged out, the header links to it. No key is ever embedded.

- **Client programs** (`clients/<lang>`, [docs/CLIENTS.md](docs/CLIENTS.md)): one complete
  program each in JavaScript, TypeScript, Python, PHP, Java, Rust, Go and C++ — push a
  `USER_LOGIN` event, query the last ten of `user/<you>`, tail the stream for 10 s (not in PHP
  and C++) — with `MEMENTO_API_KEY` / `MEMENTO_URL` from the environment, exit 2 without a key
  and 1 on an HTTP error, and a README each; the service site serves them for download.
  `clients/check.sh` runs one against a local server, and the `Client programs` workflow
  (`.github/workflows/clients.yml`) runs all eight on every change.

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

- **`@memento/server`**: the PostgreSQL schema moved from `db/schema.ts` to
  `db/schema-postgres.ts` (the `schema` export stays, now the tables of the connected
  database); the UDC field maps (`EVENTS_FIELDS`, `CPU_LOAD_FIELDS`, `API_KEY_EVENT_FIELD`)
  read their columns when a query is built. A boolean UDC field (`is_admin`, …) filters on
  `true` / `false` and refuses anything else with `validation_error`; `isoOf` takes epoch
  milliseconds too.

- The CLI's `send-message` writes with `apiKeyId: null` (was the placeholder `"cli"`): events
  now reference `memento_apikey`, and the CLI uses no key.

- A framework `415` (unsupported content type) now answers with the code
  `unsupported_media_type` instead of `bad_request`; `429` with `rate_limited`.

- **Breaking:** the health check moved from `GET <prefix>/health` to `GET <prefix>/api/health`
  (default `/memento/api/health`), so it sits under the `/api/` path like other API endpoints
  behind a proxy. The image's `memento-healthcheck` probe follows it; external monitors and
  load-balancer probes have to be pointed at the new path.

- Docs read as the website's Reference pages: the "(Phase N)" suffixes are gone from the titles,
  `docs/CLI.md` lists `simulate` (with its own section) and `retention`, `docs/TEMPLATES.md` the
  `CPU_LOAD` and `APIKEY_*` templates, and `docs/ARCHITECTURE.md` the standalone entry
  `dist/server.js` and the UDC collections and accounts as implemented.

- **Breaking (embedding API):** the server's database layer goes through one dialect seam,
  in preparation for SQLite. Everything PostgreSQL-only sits behind `db/dialect.ts` (the
  `Dialect` interface) and `db/postgres.ts` (its one implementation): SQLSTATE 23505, the
  `::` casts, `jsonb_typeof` / `->>`, `ILIKE`, `date_trunc`, `to_char`, `greatest`,
  `array_to_string`, `is distinct from`, `nulls last`, `now() - interval`. The SQL each helper
  renders is the SQL the services ran before (`test/dialect.test.ts`). `connect(url)` picks
  the database from the URL scheme and throws an error naming the scheme for anything but
  `postgres://` / `postgresql://`. `DatabaseHandle` carries `dialect` instead of `pool`, and
  `Database` is drizzle's `PgDatabase` without the node-postgres driver in its type
  (`db/client.ts` is now `db/index.ts`). Ids are generated by the application (UUID v7,
  `uuidv7()`); `gen_random_uuid()` stays the column default, so no migration.

- **`@jsudc/*` 0.3** (`@jsudc/core` 0.3.0, `@jsudc/server` 0.3.0, `@jsudc/react` 0.3.1, the
  lookups and `row_link` release) in `@memento/server`, `@memento/ui-shell`, the examples site
  and the service site. Nothing changes on the wire: the rows, filters, sorts and paging of
  `events`, `cpu_load`, `activity`, `menu` and the self-service collections are as before.
  `@jsudc/server` 0.3 checks at startup that every `lookup` field and `row_link` of the
  registry names a served collection with the named fields; memento has neither (its
  `lookups.yaml` values — event, instance and actor types — are plain `string` fields), so the
  check stays on and passes (`test/udc.test.ts`), and a collection an embedder registers with
  a lookup into a collection nobody serves now stops the start. 0.3 still ships no transport
  for `capabilities.subscribe` (memento's sources answer `subscribe: false`); the live updates
  keep riding memento's own `/ws` stream ([docs/STREAMING.md](docs/STREAMING.md)).

- **Breaking (embedding API):** an application that embeds `@memento/server` and builds or
  extends its UDC registry itself (the `udc` option, `MementoRegistry`, `eventCollections`,
  `EventCollectionSource`) with its own `@jsudc/core` / `@jsudc/server` has to be on
  `@jsudc/*` 0.3 too: the registry, its sources and their schemas are `@jsudc` 0.3 types.
  `@memento/react` does not depend on `@jsudc/*` and is unaffected; no `@memento/*` package
  has `@jsudc/*` as a peer dependency.

### Fixed

- **Text sorts no longer depend on the database's collation.** `listTemplates` (by event type
  then locale), `listTenants` and the retention sweep (by slug) and every UDC sort on a text
  field (`event_type`, `source`, an API key's `name`, …) order in Unicode code-point order on
  PostgreSQL and SQLite alike — `USER_LOGIN` before `_generic`, upper before lower case —
  through the new `dialect.bytewise` (`COLLATE "C"` / `COLLATE BINARY`). Before, a PostgreSQL
  created with a linguistic collation (the `postgres` image's `en_US.utf8` default) listed
  `_generic` first, since such a collation ignores punctuation.
- **Two server processes can start together on PostgreSQL.** The startup migrations run under
  a session-level advisory lock (`pg_advisory_lock`, on one connection of the pool): one process
  migrates, the others wait and find nothing pending. Before, two processes on a database with
  pending migrations (two replicas, or `memento` and `service` started by one
  `docker compose up`) both ran the same `CREATE …` and one exited with a unique violation.
  SQLite is unchanged (one process per file).
- **A self-service key is metered and held to its daily limit on every server process**, not
  only on one with `MEMENTO_ACCOUNTS`. Stage runs `service` (accounts on) and `memento`
  (accounts off) on one database, and a key made on the service site works on both: events
  written through `memento` were missing from the key's usage and "today" count, and its daily
  limit did not apply there. Now a key of a tenant with an account member is metered and
  limited wherever it writes (one count in Redis when `REDIS_URL` is set); a process with
  accounts still meters every key, and one without leaves other keys (CLI keys of operator
  tenants) alone. A process without accounts sends the quota mails when it has
  `MEMENTO_SERVICE_URL`, and without it leaves the day's mail to one that can. New plugin
  options `metering` (`redis`, `usage`, `mail`, `now`) and `limits`; `accounts.redis`,
  `.usage` and `.now` still work.

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
