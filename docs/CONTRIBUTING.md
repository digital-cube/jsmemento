# Contributing to JSMemento

## Dev setup

Requires **Node 24+**, **pnpm** (the version in `package.json` → `packageManager`; `corepack
enable` picks it up) and Docker or Podman for PostgreSQL + Redis.

```bash
git clone https://github.com/digital-cube/jsmemento.git && cd jsmemento
cp .env.example .env              # defaults match compose.yaml
docker compose up -d              # PostgreSQL 18 (jsmemento + jsmemento_test) and Redis 7
pnpm install
pnpm db:migrate && pnpm db:migrate:test
pnpm dev                          # server from source with reload: http://localhost:8000/memento
```

`.env` is not loaded automatically: `set -a; . ./.env; set +a`, or rely on the defaults.
Packages import each other from source during development (the `@memento/source` export
condition and the Vitest aliases), so `pnpm dev` and the tests need no build step.

## Repository layout

| path | |
|---|---|
| `packages/core` | protocol: Zod schemas, types, Filter DSL, `MementoClient`, `MementoStream` |
| `packages/lookups` | `lookups.yaml` / CSV translations, candidates, codegen |
| `packages/server` | Fastify app + plugin, Drizzle schema & migrations, rendering, WebSocket hub; `src/server.ts` is the process entry |
| `packages/cli` | the `memento` CLI |
| `packages/react` | React components and hooks |
| `packages/e2e` | end-to-end suite (private, not published) |
| `apps/example` | Vite demo of `@memento/react` |
| `Dockerfile`, `docker-compose.yaml` | image and production-like stack ([DEPLOYMENT.md](DEPLOYMENT.md)) |
| `compose.yaml` | development PostgreSQL + Redis |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the request lifecycle and the database schema.

## Running checks

Everything CI runs on a pull request, in the same order:

```bash
pnpm lint             # Biome (pnpm format fixes formatting)
pnpm typecheck        # tsc --noEmit over every package
pnpm test:coverage    # Vitest + V8 coverage, ≥ 80 % lines/statements/functions/branches per package
pnpm test:e2e         # builds the server, starts two processes, tests over HTTP + WebSocket
```

- `pnpm test` is the same as `test:coverage` without coverage.
- One package: `pnpm --filter @memento/server test`, one file:
  `pnpm --filter @memento/server exec vitest run test/chats.test.ts`, watch mode:
  `pnpm --filter @memento/core exec vitest`.
- **Coverage reports**: each package writes `coverage/index.html` (open it in a browser) and
  `coverage/coverage-summary.json`. A package below 80 % fails the run. In CI the reports are
  the `coverage` artifact of the *Lint, type check, test* job and a table in the job summary.
- Server and CLI tests use the database at `TEST_DATABASE_URL` and **truncate it** per file;
  they run one file at a time. Never point it at data you want to keep.
- Redis tests use `REDIS_URL` (default `redis://localhost:6379/0`) and are skipped with a
  warning when it is not reachable. The E2E suite requires it.

### E2E

`packages/e2e` tests what ships: it imports the built packages, starts
`packages/server/dist/server.js` twice on free ports against the test database and Redis,
pushes to one process and streams from the other.

| suite | covers |
|---|---|
| `events.e2e.ts` | push event → list / filter DSL / entity history → live delivery on `/ws`, filters, auth refusal |
| `chats.e2e.ts` | create chat → send message → see it live; read receipts; participant check |
| `tenants.e2e.ts` | tenant A sees only tenant A events (queries, stream, chats); no forged `tenant_id` |

Every run creates fresh `e2e-<label>-<id>` tenants, so the suite needs no cleanup and can run
against a shared database. `MEMENTO_E2E_URL=http://localhost:3000/memento` (plus
`MEMENTO_E2E_DATABASE_URL`, the database that server uses) targets a running server instead,
e.g. the `docker-compose.yaml` stack — CI does both. `MEMENTO_E2E_LOG_LEVEL=info` shows the
servers' logs.

## Docker locally

```bash
docker build -t jsmemento:dev .
MEMENTO_IMAGE=jsmemento:dev docker compose -f docker-compose.yaml up -d --wait
MEMENTO_E2E_URL=http://localhost:3000/memento \
MEMENTO_E2E_DATABASE_URL=postgresql://jsmemento:jsmemento@localhost:5432/jsmemento pnpm test:e2e
docker compose -f docker-compose.yaml down -v
```

If the development `compose.yaml` stack is running, move the ports first
(`MEMENTO_PORT=3300 POSTGRES_PORT=55432 REDIS_PORT=56379`) and adjust the URLs.

## Changing things

- **Database schema**: edit `packages/server/src/db/schema.ts`, then `pnpm db:generate`;
  commit the generated SQL in `packages/server/drizzle/`. The server applies it on start.
- **Vocabulary**: edit `lookups.yaml` and `i18n/translations.csv`, then
  `pnpm memento lookups validate` and `pnpm memento lookups codegen`.
- **Templates**: bundled ones are in `packages/server/templates/<locale>/`; see
  [TEMPLATES.md](TEMPLATES.md).
- Keep coverage above 80 % in the package you touch, and update the docs in `docs/` that
  describe the behaviour you changed.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat: …`, `fix: …`,
  `docs: …`, `ci: …`, `refactor: …`, `test: …`.
- Open the PR against `main`. CI must be green: *Lint, type check, test* and
  *Docker image + E2E against docker-compose.yaml*.
- User-visible changes get a line under `## [Unreleased]` in `CHANGELOG.md`.

## Releasing

All packages and the image share one version.

1. Bump `version` in the root `package.json` and in every `packages/*/package.json` and
   `apps/example/package.json` to the same `X.Y.Z`.
2. Move the `[Unreleased]` entries of `CHANGELOG.md` under `## [X.Y.Z] - <date>` and update
   the compare links at the bottom.
3. Merge to `main`, then tag that commit: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The *Release* workflow then checks that the tag equals the package versions, pushes
`ghcr.io/digital-cube/jsmemento:X.Y.Z` (and `X.Y`, `X`, `latest`), creates the GitHub release
with the changelog section as notes, and publishes `@memento/*` to npm with provenance — the
last step needs the `NPM_TOKEN` repository secret (an npm automation token of an account
that may publish to the `@memento` scope) and is skipped with a warning without it.
