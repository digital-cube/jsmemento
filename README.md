# jsmemento

Self-hosted activity ledger: applications push machine events, memento keeps them as an
immutable, tenant-isolated audit trail and serves them back per entity, per actor, as a feed.
TypeScript port of Memento (Fastify + Drizzle + PostgreSQL + Redis).

| package | |
|---|---|
| [`@memento/core`](packages/core) | Zod schemas + inferred types, API key / scope helpers, Filter DSL, envelope |
| [`@memento/server`](packages/server) | Fastify plugin & standalone server, Drizzle schema + migrations |
| [`@memento/cli`](packages/cli) | `memento` CLI: tenants, API keys, (templates in Phase 2) |

## Quick start

Requires Node 24+ and pnpm.

```bash
cp .env.example .env            # adjust if needed; the server/CLI read the environment
docker compose up -d            # PostgreSQL + Redis (creates jsmemento and jsmemento_test)
pnpm install
pnpm db:migrate && pnpm db:migrate:test

pnpm memento create-tenant acme --name "Acme Inc"
pnpm memento create-key --tenant acme --scopes read,write --name local   # prints mk_… once

pnpm dev                        # http://localhost:8000/memento
curl -X POST localhost:8000/memento/events -H "Authorization: Bearer mk_…" \
  -H 'content-type: application/json' \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}'
curl "localhost:8000/memento/entities/user/42/events" -H "Authorization: Bearer mk_…"
```

`.env` is not loaded automatically: export the variables (`set -a; . ./.env; set +a`) or rely
on the defaults, which match `compose.yaml`.

## Commands

| | |
|---|---|
| `pnpm build` / `pnpm typecheck` | Turbo over all packages |
| `pnpm test` / `pnpm test:cov` | Vitest (server + CLI need PostgreSQL at `TEST_DATABASE_URL`) |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm db:generate` | new Drizzle migration after editing `packages/server/src/db/schema.ts` |

## Docs

- [docs/API.md](docs/API.md) — endpoints with examples
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — packages, database schema, request lifecycle
- [docs/ANALYSIS.md](docs/ANALYSIS.md), [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) — background
