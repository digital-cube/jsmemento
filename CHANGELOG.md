# Changelog

All notable changes to JSMemento. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@memento/*` package and the Docker image
share one version.

## [Unreleased]

### Added

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
