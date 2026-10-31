# Changelog

All notable changes to JSMemento. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Every `@memento/*` package and the Docker image
share one version.

## [Unreleased]

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
