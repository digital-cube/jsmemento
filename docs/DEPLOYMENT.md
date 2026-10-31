# Deploying JSMemento

JSMemento ships as one Docker image, `ghcr.io/digital-cube/jsmemento`, that needs a
PostgreSQL database and (for more than one process, or for real-time delivery between
processes) Redis.

| tag | built from |
|---|---|
| `1.0.0`, `1.0`, `1`, `latest` | the release tag `v1.0.0` |
| `main`, `edge` | the newest commit on `main` |
| `sha-<short>` | that commit |

Images are multi-arch (`linux/amd64`, `linux/arm64`) and carry a build provenance attestation
(`gh attestation verify oci://ghcr.io/digital-cube/jsmemento:1.0.0 -R digital-cube/jsmemento`).

## Quick start: `docker-compose.yaml`

The repository's `docker-compose.yaml` is a production-like stack: memento, PostgreSQL 18 and
Redis 7, with health checks and named volumes.

```bash
export POSTGRES_PASSWORD='change-me'                  # or put it in .env next to the file
docker compose -f docker-compose.yaml up -d --wait    # pulls :latest (or builds with --build)

docker compose -f docker-compose.yaml exec memento memento create-tenant acme --name "Acme Inc"
docker compose -f docker-compose.yaml exec memento \
  memento create-key --tenant acme --scopes read,write --name backend   # prints mk_… once

curl localhost:3000/memento/api/health                    # {"ok":true,"data":{"status":"ok"}}
curl -X POST localhost:3000/memento/events -H "Authorization: Bearer mk_…" \
  -H 'content-type: application/json' \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}'
```

`compose.yaml` (the default file of `docker compose`) is the **development** infrastructure —
PostgreSQL + Redis only, plus the test database. Always pass `-f docker-compose.yaml` for the
full stack.

| service | port (host) | volume | health check |
|---|---|---|---|
| `memento` | `${MEMENTO_PORT:-3000}` → 3000 | `memento-data:/data` | `memento-healthcheck` (`GET /memento/api/health`) |
| `postgres` | `127.0.0.1:${POSTGRES_PORT:-5432}` | `postgres-data:/var/lib/postgresql` | `pg_isready` |
| `redis` | `127.0.0.1:${REDIS_PORT:-6379}` | `redis-data:/data` (AOF on) | `redis-cli ping` |

PostgreSQL and Redis are published on `127.0.0.1` only; set `POSTGRES_BIND` / `REDIS_BIND`
to change that, or remove their `ports:` when nothing outside the stack needs them.
`MEMENTO_IMAGE` picks another image (e.g. a pinned `ghcr.io/digital-cube/jsmemento:1.0.0`).

Upgrade: `docker compose -f docker-compose.yaml pull memento && docker compose -f docker-compose.yaml up -d`.
The server applies pending migrations when it starts, so roll out one process first when you
run several.

## The image

```bash
docker build -t jsmemento .                         # from the repository root
docker run -d -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@db:5432/jsmemento \
  -e REDIS_URL=redis://redis:6379/0 \
  ghcr.io/digital-cube/jsmemento:1.0.0
```

- Base `node:24-bookworm-slim` (Node 24 LTS); runs as the unprivileged `node` user.
- Working directory `/app`, entrypoint `node dist/server.js`: applies pending Drizzle
  migrations, loads lookups, listens. `SIGTERM` closes WebSocket clients (`1001`), Redis and
  the pool, then exits 0.
- `/usr/local/bin/memento` — the CLI (`create-tenant`, `create-key`, `revoke-key`,
  `create-template`, `lookups validate`, …; see [CLI.md](CLI.md)). It uses the same
  `DATABASE_URL` / `REDIS_URL` as the server.
- `/usr/local/bin/memento-healthcheck` — exit 0 when `GET <prefix>/api/health` answers 200;
  also the image's `HEALTHCHECK`.
- `/app/config/lookups.yaml` and `/app/config/i18n/translations.csv` — the bundled vocabulary.
  Mount your own over `/app/config` (or point `MEMENTO_LOOKUPS_PATH` elsewhere).
- `/data` — a volume; unknown lookup values are recorded under `/data/candidates`.

## Environment variables

| variable | default (image) | |
|---|---|---|
| `DATABASE_URL` | `postgresql://jsmemento:jsmemento@localhost:5432/jsmemento` | PostgreSQL connection string. **Set it.** |
| `REDIS_URL` | *(unset)* | Redis for publishing events and cross-process streaming. Unset: one process, in-memory stream. |
| `REDIS_CHANNEL_PREFIX` | `memento:events` | Channels are `<prefix>:<tenant_slug>`. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port (the code default outside the image is 8000). |
| `LOG_LEVEL` | `info` | pino: `fatal` `error` `warn` `info` `debug` `trace` `silent`. Logs are JSON on stdout. |
| `MEMENTO_API_PREFIX` | `/memento` | Path every route is mounted under. |
| `MEMENTO_DEFAULT_LOCALE` | `en` | Locale events are rendered in when a request names none. |
| `MEMENTO_LOOKUPS_PATH` | `/app/config/lookups.yaml` | Vocabulary file. Missing → lookups disabled (warning). |
| `MEMENTO_TRANSLATIONS_PATH` | `<dir of lookups>/i18n/translations.csv` | Label sheet. |
| `MEMENTO_CANDIDATES_DIR` | `/data/candidates` | Where unknown lookup values are recorded. |
| `MEMENTO_RECORD_CANDIDATES` | `true` | `false` turns recording off. |
| `MEMENTO_LOOKUPS_STRICT` | `false` | `true` rejects events whose types are not in `lookups.yaml` (`422`). |
| `MEMENTO_WS_HEARTBEAT_MS` | `30000` | WebSocket ping interval (min 1000). |
| `MEMENTO_WS_MAX_BUFFERED` | `1000` | Unwritten messages per connection before it is closed `4008`. |

`docker-compose.yaml` additionally reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`MEMENTO_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `POSTGRES_BIND`, `REDIS_BIND` and
`MEMENTO_IMAGE`.

## Behind a reverse proxy

`/memento/ws` is a WebSocket: forward `Upgrade`/`Connection` and raise the read timeout above
the heartbeat (30 s). nginx:

```nginx
location /memento/ {
    proxy_pass http://memento:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

## Scaling

Run any number of memento processes against the same PostgreSQL and Redis: each publishes
what it stores to Redis and streams every tenant its clients follow, so a client connected to
one process sees events pushed to another (the E2E suite checks exactly this). Without
`REDIS_URL`, run a single process.

## Checking a deployment

The E2E suite runs against any server:

```bash
MEMENTO_E2E_URL=https://memento.example.com/memento \
MEMENTO_E2E_DATABASE_URL=postgresql://…/jsmemento \
pnpm test:e2e
```

It creates its own `e2e-…` tenants (directly in that database) and never deletes data, so use
it on a staging database, not on production.

## Backups

Everything durable is in PostgreSQL (`pg_dump`); Redis only carries live pub/sub traffic, and
`/data/candidates` is review material. Events are immutable: a trigger refuses `DELETE` on
`memento_event` and every `UPDATE` except archiving (setting `archived_at` once).
