# jsmemento

Self-hosted activity ledger: applications push machine events, memento keeps them as an
immutable, tenant-isolated audit trail and serves them back per entity, per actor, as a feed.
TypeScript port of Memento (Fastify + Drizzle + PostgreSQL + Redis).

| package | |
|---|---|
| [`@memento/core`](packages/core) | Zod schemas + inferred types, API key / scope helpers, Filter DSL, envelope |
| [`@memento/lookups`](packages/lookups) | `lookups.yaml` vocabulary, CSV translations, candidate recorder, TS/Zod codegen |
| [`@memento/server`](packages/server) | Fastify plugin & standalone server, Drizzle schema + migrations, Handlebars rendering, WebSocket stream |
| [`@memento/cli`](packages/cli) | `memento` CLI: tenants, API keys, templates, lookups, chats |

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
curl "localhost:8000/memento/entities/user/42/events?locale=sr" -H "Authorization: Bearer mk_…"
# → "rendered": "Korisnik igor se prijavio."

# live stream of the tenant's events (any WebSocket client; key as subprotocol)
npx wscat -c "ws://localhost:8000/memento/ws?event_type=USER_LOGIN" -s memento.v1 -s "bearer.mk_…"

pnpm memento create-template --tenant acme --event-type USER_LOGIN --locale en \
  --body '{{upper actor_id}} signed in to Acme'          # per-tenant override
pnpm memento lookups validate                            # lookups.yaml + i18n/translations.csv
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
| `pnpm memento lookups codegen` | regenerate typed lookups after editing `lookups.yaml` |

## Docs

- [docs/API.md](docs/API.md) — endpoints with examples
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — packages, database schema, request lifecycle
- [docs/TEMPLATES.md](docs/TEMPLATES.md) — rendering, locale fallback, tenant templates, lookups
- [docs/CHATS.md](docs/CHATS.md) — chats: messages, seen tracking, participants, permissions, CLI
- [docs/STREAMING.md](docs/STREAMING.md) — WebSocket `/memento/ws`: auth, filters, messages, slow consumers
- [docs/ANALYSIS.md](docs/ANALYSIS.md), [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) — background
