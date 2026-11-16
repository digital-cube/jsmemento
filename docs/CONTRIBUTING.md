# Contributing to JSMemento

## Dev setup

Requires **Node 24+**, **pnpm** (the version in `package.json` → `packageManager`; `corepack
enable` picks it up) and Docker or Podman for PostgreSQL + Redis — or, to run the server and
the SQLite half of the tests, nothing else: no database service and no Redis
([SQLITE.md](SQLITE.md); `MEMENTO_TEST_DIALECT=sqlite`, [below](#running-checks)).

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

- `pnpm test` is the same as `test:coverage` without coverage. `pnpm test:full` runs
  `test:coverage` and `test:e2e` in one go with one merged coverage file
  ([§ The full suite](#the-full-suite)).
- One package: `pnpm --filter @memento/server test`, one file:
  `pnpm --filter @memento/server exec vitest run test/chats.test.ts`, watch mode:
  `pnpm --filter @memento/core exec vitest`.
- **Coverage reports**: each package writes `coverage/index.html` (open it in a browser) and
  `coverage/coverage-summary.json`. A package below 80 % fails the run. In CI the reports are
  the `coverage` artifact of the *Lint, type check, test* job and a table in the job summary.
- Server and CLI tests use the database at `TEST_DATABASE_URL` and **truncate it** per file;
  they run one file at a time. Never point it at data you want to keep.
- **Both databases.** `@memento/server` and `@memento/cli` run every suite twice, as the vitest
  projects `server` / `server-sqlite` (`cli` / `cli-sqlite`): on PostgreSQL at
  `TEST_DATABASE_URL`, and on a SQLite file in the temporary directory that the run creates,
  migrates and removes, with no Redis. One of them: `MEMENTO_TEST_DIALECT=sqlite pnpm test`,
  or in the package `pnpm test:pg` / `pnpm test:sqlite` (the SQLite run needs neither
  PostgreSQL nor Redis); one file on one: `pnpm --filter @memento/server exec vitest run
  --project server-sqlite test/chats.test.ts`. A test that cannot run on SQLite is skipped by
  name with `it.skipIf(onSqlite)` (`test/helpers.ts`) and a comment with the reason; what the
  two must answer alike goes into `test/parity.test.ts`. After a schema change,
  `pnpm db:generate` writes both migration sets (`drizzle/`, `drizzle-sqlite/`); a new column
  of `memento_event` also goes into the SQLite trigger `memento_event_archive_only`. Running
  memento on SQLite (not testing it) is [SQLITE.md](SQLITE.md).
- Redis tests use `REDIS_URL` (default `redis://localhost:6379/0`) and are skipped with a
  warning when it is not reachable. The E2E suite requires it.

### The full suite

`pnpm test:full` (`sh tools/test-full.sh` → `node tools/test-full.mjs`) is the whole suite as
one command: every package's `test:cov` (`@memento/server` and `@memento/cli` on PostgreSQL
**and** SQLite, both Vitest projects in one run, so one coverage map per package), then
`test:e2e`, then every package's coverage merged into **`coverage/coverage.json`** at the
repository root (git-ignored), with a per-package table at the end. It is what the thilo
board's Testing engine runs: [`thilo.toml`](../thilo.toml) `[testing]` has
`command = "sh tools/test-full.sh"` (which first puts the newest Node ≥ 24 from `$NVM_DIR` on
`PATH` when there is none) and `coverage_json = "coverage/coverage.json"`.

- **Needs**: `pnpm install`, PostgreSQL with the test database and Redis — the `compose.yaml`
  ones (`pnpm db:up`) or any others. `TEST_DATABASE_URL`, `REDIS_URL` (and
  `MEMENTO_E2E_DATABASE_URL`, `DATABASE_URL`) come from the environment, then `.env` (only
  these names are read from it), then the defaults of `.env.example`. When either service does
  not answer, the command says which and exits `2` before running anything.
- **Safe by construction**: it exits `2` without running anything when `TEST_DATABASE_URL` is
  not PostgreSQL, when its database name does not say *test* (`jsmemento_test`,
  `test_memento`, `memento-test2`), when it is the same database as `DATABASE_URL`, or when
  `MEMENTO_E2E_DATABASE_URL` is another database. Inside the run `DATABASE_URL` and
  `MEMENTO_E2E_DATABASE_URL` are set to the test database, `MEMENTO_E2E_URL` and
  `MEMENTO_TEST_DIALECT` are dropped — the E2E step always tests this checkout's build.
- **Exit status**: `0` only when every suite passed and every package met its coverage
  threshold (as in CI); otherwise the first failing step's status. The coverage file is written
  either way (`reportOnFailure` in each Vitest config), so a red run still has numbers.
- **Coverage file**: coverage.py's JSON format (`files`, `totals`, line numbers per file —
  what the thilo runner reads), built from Vitest's `coverage-final.json` with istanbul's line
  rule, plus `packages` with each package's totals (and Vitest's own lines / statements /
  functions / branches percentages, the ones the thresholds check).
- **Workers and memory**: every Vitest run gets `--maxWorkers=2` and Turbo runs two packages at
  a time, unless told otherwise — a full run was once killed for memory (exit 137). Change it
  with `MEMENTO_TEST_WORKERS=4` (or `off` for one worker without file parallelism, `auto` for
  Vitest's default of one per core) and `MEMENTO_TEST_CONCURRENCY=3`. A thilo test ticket's
  `workers` arrives as pytest-xdist's `-n 4` in `PYTEST_ADDOPTS` and is read the same way. The
  database suites run their files one at a time regardless (`fileParallelism: false`).
- `--no-e2e` (or `MEMENTO_TEST_E2E=0`) skips the E2E step.
- CI does not call it: the workflow runs the same steps (`test:coverage`, `test:e2e`) as
  separate steps with its own service containers, and reports per package.

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
