# Deploying JSMemento

JSMemento ships as one Docker image, `ghcr.io/digital-cube/jsmemento`, that runs on a
PostgreSQL database (with Redis when more than one process shares it) or, for one server
process on one host, on a SQLite file and nothing else ([SQLITE.md](SQLITE.md)). This file
covers what both have in common and the PostgreSQL stack of `docker-compose.yaml`.

| tag | built from |
|---|---|
| `1.1.0`, `1.1`, `1`, `latest` | the release tag `v1.1.0`, the first tagged release (`latest` always follows the newest tag) |
| `main`, `edge` | the newest commit on `main` |
| `sha-<short>` | that commit |

Images are multi-arch (`linux/amd64`, `linux/arm64`) and carry a build provenance attestation
(`gh attestation verify oci://ghcr.io/digital-cube/jsmemento:1.1.0 -R digital-cube/jsmemento`).

## Quick start: `docker-compose.yaml`

The repository's `docker-compose.yaml` is a production-like stack: memento, PostgreSQL 18 and
Redis 7, with health checks and named volumes.

```bash
# .env next to docker-compose.yaml. MEMENTO_IMAGE defaults to :latest (the newest release tag);
# pin a release, or use :main for the newest commit (or build it here with --build).
cat > .env <<'ENV'
POSTGRES_PASSWORD=change-me
MEMENTO_IMAGE=ghcr.io/digital-cube/jsmemento:1.1.0
ENV

docker compose -f docker-compose.yaml up -d --wait memento   # + postgres and redis, its dependencies

docker compose -f docker-compose.yaml exec memento memento create-tenant acme --name "Acme Inc"
docker compose -f docker-compose.yaml exec memento \
  memento create-key --tenant acme --scopes read,write --name backend   # prints mk_… once

curl localhost:3000/memento/api/health                    # {"ok":true,"data":{"status":"ok"}}
curl -X POST localhost:3000/memento/events -H "Authorization: Bearer mk_…" \
  -H 'content-type: application/json' \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}'
```

A plain `up -d` also starts `service`, the service site (below). The same steps, each with
what it prints, are the website's [Get started › Run it with Docker](https://memento-service.org/get-started/docker/).
The file names its project `jsmemento`: a second stack on the same host needs its own
`COMPOSE_PROJECT_NAME` and ports, or Compose treats it as the first one.

`compose.yaml` (the default file of `docker compose`) is the **development** infrastructure —
PostgreSQL + Redis only, plus the test database. Always pass `-f docker-compose.yaml` for the
full stack.

| service | port (host) | volume | health check |
|---|---|---|---|
| `memento` | `${MEMENTO_PORT:-3000}` → 3000 | `memento-data:/data` | `memento-healthcheck` (`GET /memento/api/health`) |
| `postgres` | `127.0.0.1:${POSTGRES_PORT:-5432}` | `postgres-data:/var/lib/postgresql` | `pg_isready` |
| `redis` | `127.0.0.1:${REDIS_PORT:-6379}` | `redis-data:/data` (AOF on) | `redis-cli ping` |
| `service` | `${SERVICE_PORT:-8201}` → 3000 | `memento-data:/data` | `memento-healthcheck` (the service site, [below](#the-service-site)) |
| `cpu-monitor` | — (profile `demo`, off by default) | — | — (pushes `CPU_LOAD` every second; see [Demo pusher](#demo-pusher-profile-demo)) |
| `simulator` | — (profile `demo`, off by default) | — | — (plays a ticket desk, one event every 3 s; see [Demo pusher](#demo-pusher-profile-demo)) |
| `retention` | — (profile `demo`, off by default) | — | — (`memento retention` once a day; see [Retention](#retention)) |

PostgreSQL and Redis are published on `127.0.0.1` only; set `POSTGRES_BIND` / `REDIS_BIND`
to change that, or remove their `ports:` when nothing outside the stack needs them.
`MEMENTO_IMAGE` picks another image (e.g. a pinned `ghcr.io/digital-cube/jsmemento:1.1.0`).

Upgrade: `docker compose -f docker-compose.yaml pull memento && docker compose -f docker-compose.yaml up -d`.
The server applies pending migrations when it starts, under a PostgreSQL advisory lock, so
several processes (replicas, `memento` and `service` on one database) may start together: one
migrates, the others wait for the lock and then find nothing pending.

## Demo pusher (profile `demo`)

The CPU monitor of the examples site (`/` and `/en/`) only moves while something pushes
`CPU_LOAD` events. The
`cpu-monitor` service does that from the same image (`memento cpu-monitor`, every
`CPU_MONITOR_INTERVAL` seconds, `server/<CPU_MONITOR_INSTANCE_ID>`), restarts with the stack and
retries on its own while the server is down. It belongs to the compose profile `demo`, so a
plain `up` neither starts it nor needs its key.

```bash
# 1. a tenant and a key with the write scope (the secret mk_… is printed once)
docker compose -f docker-compose.yaml exec memento memento create-tenant demo --name Demo
docker compose -f docker-compose.yaml exec memento \
  memento create-key --tenant demo --scopes write --name cpu-monitor-push

# 2. into .env next to docker-compose.yaml (never into the repository)
CPU_MONITOR_API_KEY=mk_…
COMPOSE_PROFILES=demo        # optional: turns the profile on for every compose command

# 3. start it (with COMPOSE_PROFILES=demo in .env a plain `up -d` does the same)
docker compose -f docker-compose.yaml --profile demo up -d
docker compose -f docker-compose.yaml --profile demo logs -f cpu-monitor
#   [10:00:00]  server/stage  load 0.52 0.41 0.30  → 0193…
```

| variable | default | |
|---|---|---|
| `CPU_MONITOR_API_KEY` | *(empty)* | Key with the `write` scope. Empty: the service exits with `no API key` and keeps being restarted — the log says so. |
| `CPU_MONITOR_TENANT` | `demo` | Checked once at start: the key must belong to this tenant (skipped for a write-only key, which cannot read `/describe`). |
| `CPU_MONITOR_INTERVAL` | `1` | Seconds between samples. |
| `CPU_MONITOR_INSTANCE_ID` | `stage` | `instance_id` of the events (the UI shows `server/<id>`). |

**The simulator.** The examples site's Activity feed (`/examples/activity`) shows the tenant's
events as sentences; the `simulator` service (same profile, same image, `memento simulate`)
gives it a story to show: a small team logging in, creating, modifying, noting and closing
tickets, and a bot closing stale ones — one event every `SIMULATOR_INTERVAL` seconds. The same
team talks in one chat room, `chat-demo-room`, which the simulator creates on its first start
and the Chat example (`/examples/chat`) shows. It needs a **write** key of the same tenant, which may be the same key as `CPU_MONITOR_API_KEY`:

```bash
# in .env (never in the repository)
SIMULATOR_API_KEY=mk_…        # write scope; e.g. the CPU_MONITOR_API_KEY value
docker compose -f docker-compose.yaml --profile demo up -d
docker compose -f docker-compose.yaml --profile demo logs -f simulator
#   [10:00:03]  TICKET_CREATED   ticket/T-4  ana created ticket T-4: "CSV export drops the last row".  → 0193…
```

| variable | default | |
|---|---|---|
| `SIMULATOR_API_KEY` | *(empty)* | Key with the `write` scope of the tenant the site shows. Empty: the service exits with `no API key` and keeps being restarted. |
| `SIMULATOR_TENANT` | `demo` | Checked once at start, like `CPU_MONITOR_TENANT`. |
| `SIMULATOR_INTERVAL` | `3` | Seconds between events. |

While the server restarts the log shows `✗ push failed … — retrying` once per sample and
`● reconnected after N failed push(es)` when it is back; the container itself keeps running. A
refused key (revoked, wrong scope) stops the process, and `restart: unless-stopped` starts it
again. To see the data without typing a key, give the site a [demo key](#demo-key-examples-site)
of the same tenant. Stop them with `docker compose -f docker-compose.yaml --profile demo stop cpu-monitor simulator`.

## Demo key (examples site)

The examples site (`apps/examples`, served at `/` and `/en/`) connects by itself when the server
has a **read-only demo key**: `GET /memento/api/demo` (no auth) answers it, and the page uses it
until the visitor pastes a key of their own. The key belongs to the deployment, never to the
repository — a key is a hash in one database, so every stage database needs its own.

```bash
# a key with the read scope only, of the tenant the pusher writes to (printed once)
docker compose -f docker-compose.yaml exec memento \
  memento create-key --tenant demo --scopes read --name examples-demo

# into .env next to docker-compose.yaml (passed to the server as MEMENTO_DEMO_API_KEY)
DEMO_API_KEY=mk_…

docker compose -f docker-compose.yaml up -d memento
curl -s localhost:3000/memento/api/demo
#   {"ok":true,"data":{"api_key":"mk_…","tenant":"demo"}}
```

At startup the server resolves the key as a request would. When it is unknown, revoked or
expired, or has any scope other than `read`, the server **refuses to start**
(`MEMENTO_DEMO_API_KEY must be a read-only key: …`) — a write key never leaves the server.
Without `DEMO_API_KEY` the route answers `404` and the page asks for a key.

## The image

```bash
docker build -t jsmemento .                         # from the repository root
docker run -d -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@db:5432/jsmemento \
  -e REDIS_URL=redis://redis:6379/0 \
  ghcr.io/digital-cube/jsmemento:1.1.0
```

- Base `node:24-bookworm-slim` (Node 24 LTS); runs as the unprivileged `node` user.
- Working directory `/app`, entrypoint `node dist/server.js`: applies pending Drizzle
  migrations (PostgreSQL: under an advisory lock, one process at a time), loads lookups, listens. `SIGTERM` closes WebSocket clients (`1001`), Redis and
  the pool, then exits 0.
- `/usr/local/bin/memento` — the CLI (`create-tenant`, `create-key`, `revoke-key`,
  `create-template`, `lookups validate`, …; see [CLI.md](CLI.md)). It uses the same
  `DATABASE_URL` / `REDIS_URL` as the server.
- `/usr/local/bin/memento-healthcheck` — exit 0 when `GET <prefix>/api/health` answers 200;
  also the image's `HEALTHCHECK`.
- `/app/config/lookups.yaml` and `/app/config/i18n/translations.csv` — the bundled vocabulary.
  Mount your own over `/app/config` (or point `MEMENTO_LOOKUPS_PATH` elsewhere).
- `/app/config/menu.yaml` — the examples site's menu (`MEMENTO_MENU_PATH`), served as the
  `menu` UDC collection; `/app/ui` — the built examples site (`MEMENTO_UI_DIR`).
- `/app/config/menu-service.yaml` and `/app/ui-service` — the service site (`apps/service`) and
  its menu, served by the second container ([The service site](#the-service-site)).
- `/data` — a volume; unknown lookup values are recorded under `/data/candidates`.

## Environment variables

What the server reads when it starts; the CLI in the image reads the same `DATABASE_URL` and
`REDIS_URL`. The defaults are the image's.

| variable | default (image) | |
|---|---|---|
| `DATABASE_URL` | `postgresql://jsmemento:jsmemento@localhost:5432/jsmemento` | The database. **Set it.** `postgresql://user:password@host:5432/db` (or `postgres://…`): PostgreSQL, any number of processes. `file:<path>` (relative to the working directory) or `file:///abs/path.db`: SQLite, one server process — see [SQLITE.md](SQLITE.md). `:memory:`: SQLite in memory, for tests. The server migrates it at start; the CLI uses the same. |
| `TEST_DATABASE_URL` | `postgresql://jsmemento:jsmemento@localhost:5432/jsmemento_test` | The test suites only (the same forms). |
| `REDIS_URL` | *(unset)* | Redis for publishing events and cross-process streaming, and for the shared rate-limit and quota counters. Unset: one process, in-memory stream, counters in the process. Optional on both databases; on SQLite it does not allow a second process. |
| `REDIS_CHANNEL_PREFIX` | `memento:events` | Channels are `<prefix>:<tenant_slug>`. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port (the code default outside the image is 8000). |
| `LOG_LEVEL` | `info` | pino: `fatal` `error` `warn` `info` `debug` `trace` `silent`. Logs are JSON on stdout. |
| `MEMENTO_API_PREFIX` | `/memento` | Path every route is mounted under. |
| `MEMENTO_UI_DIR` | `/app/ui` (image) · unset | Built web UI (the examples site, `apps/examples`) served at `/` and `/en/`; unset → API only. The `service` container: `/app/ui-service`. |
| `MEMENTO_MENU_PATH` | `/app/config/menu.yaml` (image) · `menu.yaml` at the repository root | The examples site's sidebar, served as the `menu` UDC collection. Missing → no `menu` collection (warning); the site shows its built-in entries. |
| `MEMENTO_DEMO_API_KEY` | *(unset)* | Read-only key `GET <prefix>/api/demo` hands to the examples site ([Demo key](#demo-key-examples-site)). Not exactly `read`, unknown or revoked → the server does not start. Compose: `DEMO_API_KEY`. |
| `MEMENTO_DEFAULT_LOCALE` | `en` | Locale events are rendered in when a request names none. |
| `MEMENTO_LOOKUPS_PATH` | `/app/config/lookups.yaml` | Vocabulary file. Missing → lookups disabled (warning). |
| `MEMENTO_TRANSLATIONS_PATH` | `<dir of lookups>/i18n/translations.csv` | Label sheet. |
| `MEMENTO_CANDIDATES_DIR` | `/data/candidates` | Where unknown lookup values are recorded. |
| `MEMENTO_RECORD_CANDIDATES` | `true` | `false` turns recording off. |
| `MEMENTO_LOOKUPS_STRICT` | `false` | `true` rejects events whose types are not in `lookups.yaml` (`422`). |
| `MEMENTO_WS_HEARTBEAT_MS` | `30000` | WebSocket ping interval (min 1000). |
| `MEMENTO_WS_MAX_BUFFERED` | `1000` | Unwritten messages per connection before it is closed `4008`. |
| `MEMENTO_ACCOUNTS` | `false` | Self-service accounts: the `/auth/*` routes and the session cookie ([Self-service accounts](#self-service-accounts)). Off → none of it is reachable. Compose: `ACCOUNTS`. |
| `MEMENTO_SERVICE_URL` | *(unset)* | Public origin of the service site (`https://service.stage.memento-service.org`): the links in verify / reset / quota mails. **Required** with accounts on. Without accounts it turns on the quota mails of that process ([Quotas](#quotas)); unset there → the process sends none. Compose: `SERVICE_URL`. |
| `MEMENTO_BREVO_API_KEY` | *(unset)* | Brevo transactional mail key. Unset → mails are logged at info level with their full text (`LogMailer`). Compose: `BREVO_API_KEY`. |
| `MEMENTO_MAIL_FROM` | *(unset)* | `Name <address>`, required with the Brevo key; the address must be a **sender verified in Brevo**. Compose: `MAIL_FROM`. |
| `MEMENTO_TRUST_PROXY` | `false` | Fastify `trustProxy`: client IP from `X-Forwarded-For` (rate limits), https from `X-Forwarded-Proto` (`Secure` cookie). `true` only behind a proxy that sets them. Compose: `TRUST_PROXY`. |
| `MEMENTO_SESSION_DAYS` | `30` | Sliding lifetime of a session (and the cookie's `Max-Age`). |
| `MEMENTO_DEFAULT_MAX_KEYS` | `10` | Live (not deleted, not revoked) API keys a tenant without its own `max_keys` may hold; `POST /keys` past it is `409 limit_reached`. Compose: `DEFAULT_MAX_KEYS`. |
| `MEMENTO_DEFAULT_DAILY_LIMIT` | `100000` | Events per UTC day of a limited API key without its own `daily_limit` (every key with accounts on, a self-service tenant's key on any process; [Quotas](#quotas)): 80 % mails a warning, past 100 % the key's writes are `429 quota_exceeded` until midnight UTC. Compose: `DEFAULT_DAILY_LIMIT`. |
| `MEMENTO_MAX_DAILY_LIMIT` | *(unset)* | Highest `daily_limit` a user may give a key; unset → none. Compose: `MAX_DAILY_LIMIT`. |

`docker-compose.yaml` additionally reads `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`MEMENTO_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `POSTGRES_BIND`, `REDIS_BIND` and
`MEMENTO_IMAGE`, `SERVICE_PORT` (the `service` container's host port, default 8201), and passes `ACCOUNTS`, `SERVICE_URL`, `BREVO_API_KEY`, `MAIL_FROM`,
`TRUST_PROXY`, `DEFAULT_MAX_KEYS`, `DEFAULT_DAILY_LIMIT`, `MAX_DAILY_LIMIT` to the server as the `MEMENTO_*` variables above (empty by default); the `demo` profile adds the `CPU_MONITOR_*` variables
([Demo pusher](#demo-pusher-profile-demo)).

## Self-service accounts

`MEMENTO_ACCOUNTS=true` turns on registration, sign-in and the `memento_session` cookie
([API.md "Accounts"](API.md#accounts-memento_accountstrue)). In `.env` next to
`docker-compose.yaml`:

```bash
ACCOUNTS=true
SERVICE_URL=https://service.stage.memento-service.org
BREVO_API_KEY=xkeysib-…          # never into the repository
MAIL_FROM=memento <info@example.com>
TRUST_PROXY=true                 # behind nginx
```

- **Brevo sender verification:** Brevo refuses mail from an address it has not verified. In
  Brevo → *Senders, Domains & Dedicated IPs*, add the `MAIL_FROM` address as a sender (or
  authenticate its domain with the DKIM/DMARC records Brevo shows) before turning the key on.
  A refused mail is logged as `brevo refused the mail` (with Brevo's message) and the request
  still succeeds — check the logs after the first registration.
- Without `BREVO_API_KEY` every mail is logged at info level with its full text, links
  included: fine for development, not for a public instance.
- Rate limit counters go to Redis when `REDIS_URL` is set, so every process shares them.
- `TRUST_PROXY=true` only when the port is reachable through the proxy alone: otherwise a
  client picks its own IP with `X-Forwarded-For` and walks around the rate limits.
- Users are managed with the CLI: `memento list-users`, `make-admin`, `disable-user`,
  `verify-user` ([CLI.md](CLI.md#users)).
- Migration `0004_accounts` (applied at startup) adds `memento_user`, `memento_tenant_user`,
  `memento_session`, `memento_user_token` and the `plan` / `max_keys` / `retention_days`
  columns of `memento_tenant`.
- Migration `0005_apikey_lifecycle` (applied at startup) adds `disabled_at`, `deleted_at`,
  `daily_limit`, `created_by`, `quota_warned_on`, `quota_exceeded_on` to `memento_apikey`,
  `api_key_id` (+ index `memento_event_apikey_idx`) to `memento_event`, and the hourly
  counters table `memento_apikey_usage`. Existing events get `api_key_id = NULL`.

## The service site

`https://service.stage.memento-service.org/` is `apps/service`: people register, verify their
address, create API keys (each shown **once**), and watch per key what it writes — activity per
minute, the events, hourly usage — pause, resume, re-limit and delete keys; administrators see
every user and key. It is a **second container of the same image**, `service` in
`docker-compose.yaml`:

| | `memento` | `service` |
|---|---|---|
| UI (`MEMENTO_UI_DIR`) | `/app/ui` — the examples site | `/app/ui-service` — the service site |
| menu (`MEMENTO_MENU_PATH`) | `/app/config/menu.yaml` | `/app/config/menu-service.yaml` |
| accounts | `ACCOUNTS` (empty: off) | always on, `TRUST_PROXY` on |
| demo key | `DEMO_API_KEY` | none |
| host port | `MEMENTO_PORT` (3000) | `SERVICE_PORT` (8201) |

On SQLite there is one server process per file, so no second container: that process serves
the service site *instead of* the examples site, with the same variables
([SQLITE.md § Accounts and the service site](SQLITE.md#accounts-and-the-service-site)).

Both share `DATABASE_URL`, `REDIS_URL` and the lookups, so a key created on the service site
pushes events to either container (`MEMENTO_URL=https://service.stage.memento-service.org/memento`
is what the once-view prints). The `service` container takes `SERVICE_URL` (the links in mails;
default `http://localhost:8201`), `BREVO_API_KEY`, `MAIL_FROM` and the quota variables. `memento`
gets `SERVICE_URL`, the Brevo and the quota variables too, with `ACCOUNTS` empty: a key made on
the service site is metered and held to its daily limit on whichever container it writes
through (one count, in Redis), and the 80 % / 100 % quota mails are sent by whichever container
stores the event ([Quotas](#quotas)).

- **Keys** come only from the site (or `memento create-key` for CLI keys). **Mails** (verify,
  reset, quota) go through Brevo with `BREVO_API_KEY` + `MAIL_FROM` (a verified sender); without
  the key they are logged — `docker compose logs service | grep verify/` finds the link.
- The site reads everything through UDC with the `memento_session` cookie: `api_keys`,
  `api_key_events`, `api_key_history` (a key's own lifecycle), `api_key_activity`,
  `api_key_usage`, `admin_users`, `admin_api_keys`, and the `menu` (which, with accounts on,
  takes a key *or* the cookie). Writes are `/auth/*`, `/keys*`, `/admin/*`.
- **No live stream:** `/memento/ws` takes an API key and the site has only the cookie, so the
  key page polls its collections every 10 s instead.
- An administrator: `docker compose exec service memento make-admin ana@example.com`; the
  sidebar then shows *Administration* (`/admin/users`).

nginx (done by hand after deploying; the examples vhost stays as it is):

```nginx
server {
    listen 443 ssl;
    server_name service.stage.memento-service.org;
    # ssl_certificate … (certbot)

    location / {
        proxy_pass http://127.0.0.1:8201;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

`X-Forwarded-Proto` matters: the session cookie is `Secure` only when the server sees https.

### Quotas

A **limited** API key is metered and held to its daily event limit (`daily_limit`, else
`DEFAULT_DAILY_LIMIT`, 100 000): at 80 % the key's creator (or the tenant's owner) gets a
warning mail, past 100 % the key's writes answer `429 quota_exceeded` until midnight UTC, and
one more mail goes out. A producer pushing one event a second writes 86 400 a day; raise
`DEFAULT_DAILY_LIMIT` (or the key's limit with `PATCH /keys/:id`) for heavier ones. Which keys
are limited:

| process | key of a self-service tenant (one with an account) | key of any other tenant (CLI) |
|---|---|---|
| accounts on | limited and metered | limited and metered |
| accounts off | limited and metered | neither |

So a key made on the service site counts the same whichever process on the database receives
its events: stage's `memento` (accounts off) meters and limits it like `service` does. A
deployment that never had accounts has no self-service tenants, so nothing there is limited.

- Every process on one database must agree on the **counter store**: all with `REDIS_URL`, or
  none — a process without Redis neither sees nor adds to the Redis count.
- **Mails** go out from the process that stores the event: with accounts through its mailer;
  without accounts only when it has `SERVICE_URL` (the link in the mail), Brevo when
  `BREVO_API_KEY` is set. A process without `SERVICE_URL` sends none and leaves the day's mail
  to one that can.

- **Redis** (`REDIS_URL`) holds today's counters (`memento:quota:<key>:<day>`, expire after
  2 days), shared by every process. Without it the count is the sum of today's
  `memento_apikey_usage` rows plus each process's unflushed buffer — exact with one process,
  up to 5 s behind per process with several.
- The **usage meter** writes `memento_apikey_usage` (requests, events written, rows read,
  stream seconds, bytes in, per key and hour) every 5 s and on shutdown. The table grows by at
  most one row per active key per hour.

## The website

`https://stage.memento-service.org/` is `apps/website` (`@jsmemento/website`): memento's own
website, Astro + Starlight, static files served by nginx on the stage VM like
`stage.jsudc.dev`. It is **not part of the image** (the Dockerfile's turbo filters leave it
out) and has no server: one build, swapped in under a symlink.

The build reads three variables (`apps/website/src/site.mjs`); the defaults are production's:

| variable | | default | stage |
|---|---|---|---|
| `SITE_URL` | the site's own origin (canonical links, sitemap) | `https://memento-service.org` | `https://stage.memento-service.org` |
| `EXAMPLE_URL` | the examples site ("Open the live example") | `https://examples.stage.memento-service.org` | the same |
| `SERVICE_URL` | the service site ("Get an API key") | `https://service.stage.memento-service.org` | the same |

The last two still default to stage; production's examples and service sites exist since
2026-11-17 ([Production](#production)), and the defaults move with the production website.

On the stage VM, from any copy of the repository:

```bash
deploy/website/stage.sh --install                    # once: links the vhost, nginx -t, reload, deploy
deploy/website/stage.sh                              # every deploy: builds origin/main and swaps it in
deploy/website/stage.sh --branch <name>              # a branch before review
REPO_URL=/home/digital/work/jsmemento deploy/website/stage.sh --branch main   # commits not pushed yet
```

It clones or fetches the repository into `/home/digital/sites/stage.memento-service.org/src`,
checks out `origin/<branch>`, installs `@jsmemento/website` and its dependencies only
(`pnpm install --frozen-lockfile --filter @jsmemento/website...`, pnpm from `packageManager`
through corepack, Node 24 from nvm), builds with the stage variables, copies
`apps/website/dist` to `releases/<short sha>/`, repoints `current` atomically, keeps three
releases, and fails unless `/` answers 200 and a missing page the site's 404 through nginx on
127.0.0.1, and `/` answers this build through the edge. The same commit with the same variables
rebuilds nothing. `deploy/website/stage.sh --help` has the options and exit codes.

The vhost is `deploy/website/nginx/stage.memento-service.org.conf`, linked into
`/etc/nginx/sites-enabled/stage.memento-service.org` from the deployed checkout: `:80` only
(TLS ends at the edge), `root …/current`, `/_astro/` cached for a year (content-hashed), the
rest `no-cache`, `error_page 404 /404.html`, `absolute_redirect off`.

**The name was taken.** The old Python mementoservice app's vhost,
`/etc/nginx/sites-available/nginx-stage.memento-service.org.conf` (a copy of
`deploy/nginx-stage.memento-service.org.conf` in the mementoservice repository), served
`server_name stage.memento-service.org *.stage.memento-service.org;` with a
`stage.memento-service.org` line in its `map $host`. Two server blocks with the same exact name
make nginx warn and take the first, so the bare name was removed from that `server_name` and
from the `map` on the VM (by hand, with sudo). The wildcard stays: the old app's tenant hosts
(`developer.`, `admin.`, `digitalcube.`, … `.stage.memento-service.org`) keep working, and
`examples.` / `service.` have exact vhosts of their own (`memento-stage`,
`memento-service-stage`) that win over a wildcard. The same edit is still owed to the
mementoservice repository's copy; a redeploy of that vhost from there would take the name back.

## The stage stack

`examples.stage.memento-service.org` and `service.stage.memento-service.org` are the Compose
project `jsmemento` of `docker-compose.yaml` on the stage VM (rootless podman, `podman compose`,
profile `demo`, ports 8200 / 8201, `.env` next to the file). It stays on **PostgreSQL**: two
server containers (`memento` and `service`) share one database, which SQLite's one process per
file does not allow, and it is the one long-running installation on real data, so it is the
regression check for the database layer on PostgreSQL ([SQLITE.md](SQLITE.md) is the other
option, for a single process).

**After a reboot** the stack comes back through a systemd user unit,
[`deploy/stage/jsmemento-stage.service`](../deploy/stage/jsmemento-stage.service), with
lingering on. The restart policy alone does not do it: podman has no daemon, and its boot-time
`podman-restart.service` starts only containers with `restart: always`, not the file's
`unless-stopped`. The unit starts `memento` and waits until it is healthy, then the rest.
That order is no longer needed for correctness (the migrations run under an advisory lock,
TCKFETCQTN); it keeps a broken `memento` from taking the rest down with it. Install it once:

```bash
cp deploy/stage/jsmemento-stage.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now jsmemento-stage.service
systemctl --user restart jsmemento-stage.service   # what a reboot does: stop, then start
```

**A redeploy**, from the checkout the unit names: `pg_dump` first (`podman exec
jsmemento-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > …`), tag the
running image for rollback, `podman build -t ghcr.io/digital-cube/jsmemento:latest -t
ghcr.io/digital-cube/jsmemento:<short sha> .`, then `podman compose -f docker-compose.yaml up -d
--wait memento` and `podman compose -f docker-compose.yaml up -d --wait`.

## Production

`https://examples.memento-service.org` (the examples site) and
`https://service.memento-service.org` (the service site) run on the VM
**`digitalcube-production-websites`** (`ssh digitalcube-production-websites` from the stage VM),
**natively**: nothing on that VM runs in a container, so `docker-compose.yaml`'s services are
systemd user units there, on the VM's own PostgreSQL 18 and Redis, behind its nginx. TLS ends
at the edge; the vhosts listen on `:80`. Production runs **releases** (a tag), not `main`.

| unit (`systemctl --user`) | compose service | |
|---|---|---|
| `memento-prod` | `memento` | 127.0.0.1:8200, the examples site, accounts off, the demo key |
| `memento-service-prod` | `service` | 127.0.0.1:8201, the service site, accounts on (after `memento-prod`) |
| `memento-prod-cpu-monitor` | `cpu-monitor` | `CPU_LOAD` of tenant `demo` every `CPU_MONITOR_INTERVAL` s (5) |
| `memento-prod-simulator` | `simulator` | the ticket desk of tenant `demo`, one event every `SIMULATOR_INTERVAL` s (10) |
| `memento-prod-retention.timer` | `retention` | `memento retention` daily at 03:30 UTC (a oneshot service) |

The pushers are slower than stage's (1 s and 3 s): events are immutable and retention only
archives, so the database only grows. At stage's rates (~115 000 events, ~90 MB a day) it would
outgrow the VM's free disk within a year; at 5 s / 10 s it is ~26 000 events, ~20 MB a day.
The intervals are in `.env`.

Everything lives under `/home/digital/sites/examples.memento-service.org/`:

| path | |
|---|---|
| `src/` | the application, a clone of the repository detached at the release tag, built in place (pnpm through corepack, the Dockerfile's turbo filters) |
| `ops/` | a `git worktree` of `src/` at `origin/main`: `deploy/examples/` — `prod.sh`, `systemd/`, `nginx/`. The units in `~/.config/systemd/user/` and the vhosts in `/etc/nginx/sites-available/` are symlinks into it |
| `.env` | mode 600, the **secrets** and what every process shares: `DATABASE_URL` (role and database `memento`, generated password), `REDIS_URL`, `REDIS_CHANNEL_PREFIX`, `MEMENTO_SERVICE_URL`, the Brevo key and `MEMENTO_MAIL_FROM`, the quotas, the demo key and the pushers' keys. Per-process variables (`PORT`, `MEMENTO_UI_DIR`, `MEMENTO_MENU_PATH`, `MEMENTO_ACCOUNTS`, `MEMENTO_TRUST_PROXY`) are in the units and must not be in `.env`. Not shell syntax: do not `source` it |
| `bin/memento` | the CLI of `src/` with `.env` loaded |
| `node` | → the newest `~/.nvm/versions/node/v24.*/bin` |
| `data/candidates/` | `MEMENTO_CANDIDATES_DIR` |

**Why two checkouts.** The deploy files came after `v1.1.0`, so the tag cannot carry them: `ops/`
follows `main` (`--deploy-branch`), `src/` is the release (`--ref`). A unit or vhost change
reaches production with the next `prod.sh` run, whatever release it deploys.

**Redis** is shared with other projects on that VM: memento uses database 3 (quota counters
`memento:quota:*`, auth rate limits `memento-auth-*`) and the channel prefix
`memento-prod:events`, because pub/sub channels ignore the database number.

```bash
ssh digitalcube-production-websites
cd ~/sites/examples.memento-service.org
ops/deploy/examples/prod.sh                      # redeploy (the units, vhosts and checks); v1.1.0
ops/deploy/examples/prod.sh --ref v1.2.0         # a new release: fetch, build, restart, check
ops/deploy/examples/prod.sh --ref v1.1.0         # roll back to the previous release
ops/deploy/examples/prod.sh --help               # options and exit codes
```

**The default `--ref`** is the release this script was written for; a run without `--ref`
deploys it, so pass `--ref` every time after an upgrade (or move `DEFAULT_REF` in the script).
A deploy builds in `src/` while the old processes run, then restarts them (a few seconds of
502). Exit code 6 means the VM serves both sites but the edge does not route them.

**A rollback** across a release that added migrations needs the database of before: migrations
only go forward, and an older server refuses a schema it does not know. Take a dump first
(below), and restore it when rolling back over a migration.

**Backup** (nothing on the VM backs up PostgreSQL on a schedule):

```bash
mkdir -p ~/backups && sudo -u postgres pg_dump -Fc memento > ~/backups/memento-$(date +%F).dump
# restore into an empty database memento: sudo -u postgres pg_restore -d memento --no-owner --role=memento <file>
```

**First installation** (done once, 2026-11-17): `scp` the script to the VM and run it from
`/tmp`; it clones everything else.

```bash
scp deploy/examples/prod.sh digitalcube-production-websites:/tmp/memento-prod.sh
ssh digitalcube-production-websites /tmp/memento-prod.sh --install
# the Brevo key and sender, read from stage's .env into a variable and sent on stdin
# (never on a command line, never printed):
{ grep '^BREVO_API_KEY=' .env | sed 's/^/MEMENTO_/'; grep '^MAIL_FROM=' .env | sed 's/^/MEMENTO_/'; } |
  ssh digitalcube-production-websites sites/examples.memento-service.org/ops/deploy/examples/prod.sh --import-env
ssh digitalcube-production-websites sites/examples.memento-service.org/ops/deploy/examples/prod.sh
```

`--install` creates the role and database `memento`, `.env`, the tenant `demo` with a read-only
demo key and one write key per pusher (production's own; a key is a hash in one database),
turns linger on, links and enables the units, and keeps the hand-written "coming soon" vhosts as
`sites-available/<host>.coming-soon`. Repeating it changes nothing that exists.

**Quotas** (`.env`): `MEMENTO_DEFAULT_MAX_KEYS=10`, `MEMENTO_DEFAULT_DAILY_LIMIT=100000`, no
`MEMENTO_MAX_DAILY_LIMIT` — stage's values (stage sets none, so the defaults). Change a line,
then `systemctl --user restart memento-prod memento-service-prod`.

**An administrator** of the service site: register on `https://service.memento-service.org`,
then `~/sites/examples.memento-service.org/bin/memento make-admin <email>` on the VM
(`verify-user`, `list-users`, `disable-user` likewise).

Logs: `journalctl --user -u memento-prod -f` (and `-u memento-service-prod`, …); nginx's in
`/var/log/nginx/{examples,service}.memento-service.org.*.log`.

## Retention

`memento retention` archives (sets `archived_at`, the one change the immutability trigger
allows) the events older than each tenant's `retention_days`, 10 000 per statement; a tenant
with `retention_days` NULL — every tenant, until you set it — keeps everything. Archived events
disappear from every list, query, UDC collection and the stream at once.

```bash
docker compose -f docker-compose.yaml exec memento memento retention --dry-run
#   acme: would archive 1520 events older than 30 days (before 2026-10-02T08:00:00.000Z)
psql … -c "update memento_tenant set retention_days = 30 where slug = 'acme'"
```

On SQLite the same `UPDATE` goes through `sqlite3` or Node, and cron runs the command next to
the server ([SQLITE.md § Retention from cron](SQLITE.md#retention-from-cron)).

The `retention` service of `docker-compose.yaml` (profile `demo`, same image) runs it once a
day: `sh -c 'while true; do memento retention; sleep 86400; done'`. Harmless while no tenant has
`retention_days`.

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
    # with MEMENTO_TRUST_PROXY=true (accounts: client IP for rate limits, Secure cookie)
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Scaling

Run any number of memento processes against the same PostgreSQL and Redis: each publishes
what it stores to Redis and streams every tenant its clients follow, so a client connected to
one process sees events pushed to another (the E2E suite checks exactly this). Without
`REDIS_URL`, run a single process. On SQLite, always one server process, with or without
Redis ([SQLITE.md](SQLITE.md#without-redis-and-with-it)).

## Running on SQLite

For an installation that must not depend on a database service (one machine, one server
process, no PostgreSQL and no Redis), point `DATABASE_URL` at a file and leave `REDIS_URL`
unset: `DATABASE_URL=file:/data/memento.db` in the image, with `/data` on a volume. The server
creates and migrates the file at start; the `memento` CLI works next to it. Which database fits
(a feature-by-feature table), the quick start, the image and a Compose file without `postgres`
and `redis`, embedding, accounts and the service site, the CLI next to the server, backups with
`VACUUM INTO`, and the limits are in the guide: **[SQLITE.md](SQLITE.md)**.

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

Everything durable is in the database — PostgreSQL (`pg_dump`) or the SQLite file
([SQLITE.md § Operations](SQLITE.md#operations): `VACUUM INTO`); Redis only carries live pub/sub
traffic, and `/data/candidates` is review material. Events are immutable: a trigger refuses `DELETE` on
`memento_event` and every `UPDATE` except archiving (setting `archived_at` once).
