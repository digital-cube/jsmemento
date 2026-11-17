# Running JSMemento on SQLite

JSMemento runs on PostgreSQL or on a single SQLite file. This guide covers SQLite from an empty
directory to a running server: when to choose it, the quick start, the image, embedding the
Fastify plugin, what runs where without Redis, accounts and the service site, the CLI next to
the server, operating the file, and what SQLite cannot do. For everything that is the same on
both databases (the image, every environment variable, the reverse proxy, the service site's
mails and quotas), see [DEPLOYMENT.md](DEPLOYMENT.md).

Contents: [SQLite or PostgreSQL](#sqlite-or-postgresql) · [Quick start](#quick-start-a-server-on-a-sqlite-file) ·
[The image](#the-image-on-sqlite) · [Embedded](#embedded-the-plugin-in-your-application) ·
[Without Redis, and with it](#without-redis-and-with-it) · [Accounts and the service site](#accounts-and-the-service-site) ·
[The CLI next to the server](#the-cli-next-to-a-running-server) · [Operations](#operations) ·
[Limits](#limits-and-known-differences) · [Moving between the databases](#moving-between-the-databases)

> SQLite support is in `CHANGELOG.md` `[Unreleased]`. The first release that has it (planned as
> 1.1.0) publishes `@memento/*` on npm and the image `ghcr.io/digital-cube/jsmemento` with it.
> Until then, no npm package and no image tag has SQLite: build both from the repository.
> This guide's runs did exactly that ([below](#installing-before-the-release)).

## SQLite or PostgreSQL

| | PostgreSQL (default) | SQLite (`file:<path>`) |
|---|---|---|
| what it needs | a PostgreSQL service (`docker-compose.yaml`: PostgreSQL 18) | nothing: Node's built-in `node:sqlite` (Node 24+), one file on a local disk |
| events (push, batch, query, Filter DSL, entity history, archive), templates and rendering, chats, seen / stars, tenants, API keys, lookups, the CLI | yes | yes |
| UDC collections (`events`, `cpu_load`, `activity`, `menu`, the service site's collections), filters, sorts, paging | yes | yes, with the same answers (`packages/server/test/parity.test.ts`) |
| the `/ws` stream | yes. With Redis, across processes | yes, from the one process (the in-process bus) |
| daily quotas and rate limits | yes. Shared through Redis, or per process without it | yes, in the process: the quota from the usage table, rate limits in memory |
| self-service accounts and the service site | yes. The service site is a second container (`service`) | accounts: yes. The service site: **instead of** the examples site, from the one process ([below](#accounts-and-the-service-site)) |
| retention | `memento retention` (cron, or the `retention` service) | the same command, next to the running server |
| Redis (`REDIS_URL`) | optional. Needed for more than one process | optional and not needed. It does **not** allow a second server process |
| processes | any number of server processes | **one server process**; CLI commands may run next to it |
| hosts | any | **one** (the file and the server on the same machine) |
| backup | `pg_dump` | `VACUUM INTO`, or a copy while stopped |
| scaling | more processes behind a proxy, with Redis | none: one process. Move to PostgreSQL when it is not enough |
| moving to the other database | no tool | no tool ([below](#moving-between-the-databases)) |

**Choose SQLite** for an installation that must not depend on a database service: memento on a
customer's own machine, an application that embeds memento and ships as one process, a demo, a
development box. The server and the CLI open the file directly. Beside Node there is nothing to
install, start or upgrade.

**Choose PostgreSQL** when you need more than one server process (for availability or load),
the examples site and the service site side by side, or a database your operations already back
up and monitor. It is the default (`docker-compose.yaml`) and the stage stack runs on it.

## Quick start: a server on a SQLite file

Node 24+ (`node --version`), `curl` and `jq`. No Docker, no database service, no Redis.

```sh
mkdir my-memento && cd my-memento
npm install @memento/server @memento/cli
```

### Installing before the release

Until the release is on npm, build and pack the packages from a clone, then install the
tarballs instead. This guide's runs installed them this way:

```sh
git clone https://github.com/digital-cube/jsmemento.git && cd jsmemento
pnpm install && pnpm --filter "@memento/cli..." build
for p in core lookups server cli; do (cd packages/$p && pnpm pack --pack-destination ../../../memento-tarballs); done
cd ../my-memento
npm install ../memento-tarballs/memento-{core,lookups,server,cli}-1.0.0.tgz
```

### The database URL

`DATABASE_URL` picks the database by its form:

| `DATABASE_URL` | database |
|---|---|
| `file:data/memento.db` | SQLite, relative to the working directory |
| `file:///var/lib/memento/memento.db` | SQLite, an absolute path (an empty host only: `file://host/…` is refused) |
| `:memory:` | SQLite in this process's memory: tests only ([below](#operations)) |
| `postgresql://user:password@host:5432/db` | PostgreSQL (the default when `DATABASE_URL` is unset) |

The server and the CLI read the same variable. Every command below ran with `REDIS_URL` unset
and no PostgreSQL URL anywhere in the environment:

```sh
export DATABASE_URL=file:data/memento.db
```

Apply the migrations, then create the first tenant and its API key. Each CLI command opens the
file directly, so no server has to be running yet. The server would also migrate at start;
`memento migrate` creates the file and its directory now.

```sh
npx memento migrate
#   migrations applied
ls -la data
#   -rw-r--r-- 1 digital digital 217088 Nov 16 01:06 memento.db

npx memento create-tenant acme --name "Acme Inc"
#   created tenant acme (Acme Inc) id=01a1e1e4-7b1b-75f5-8e74-556e471fdb49

npx memento create-key --tenant acme --scopes read,write --name backend
#   created key "backend" for acme [read,write]
#   prefix: q6hndb7s
#   key:    mk_q6hndb7s_qXSYIUqKeHLHfrwmDpkMPBdypsPQtZhe
#   Store it now: it cannot be shown again.

export KEY=mk_q6hndb7s_qXSYIUqKeHLHfrwmDpkMPBdypsPQtZhe    # yours, from the line above
```

Start the server. It listens on `0.0.0.0:8000` by default; this run used port 9300:

```sh
PORT=9300 node node_modules/@memento/server/dist/server.js
#   {"level":30,…,"database":"SQLite …/my-memento/data/memento.db","msg":"database migrated and open"}
#   {"level":40,…,"msg":"…/my-memento/node_modules/lookups.yaml not found: lookups disabled"}
#   {"level":40,…,"msg":"…/my-memento/node_modules/menu.yaml not found: no menu UDC collection"}
#   {"level":30,…,"msg":"Server listening at http://127.0.0.1:9300"}
```

The log is JSON on stdout. It has no Redis line and no PostgreSQL line. The two warnings are
expected for an npm install. The vocabulary (`MEMENTO_LOOKUPS_PATH`) and the examples site's
menu (`MEMENTO_MENU_PATH`) are optional files the image bundles and the npm packages do not.
Events still render: the templates ship in the package. In a second terminal, with the same
`KEY`:

```sh
curl -s localhost:9300/memento/api/health
#   {"ok":true,"data":{"status":"ok"}}
```

Open the stream first, then push one event. This client is a Node one-liner (Node 24 has a
`WebSocket` client built in); any WebSocket client works, with the key as a subprotocol
([STREAMING.md](STREAMING.md)):

```sh
node -e 'const ws = new WebSocket("ws://localhost:9300/memento/ws?event_type=USER_LOGIN", ["memento.v1", `bearer.${process.env.KEY}`]); ws.onmessage = (m) => { const msg = JSON.parse(m.data); console.log(msg.kind, msg.payload.actor_id ?? "", msg.payload.rendered ?? ""); if (msg.kind === "memento.event.new") ws.close(); }' &

curl -s -X POST localhost:9300/memento/events -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' \
    -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}' \
    | jq '.data | {id, event_type, instance_type, instance_id, rendered}'
#   {
#     "id": "01a1e1e4-8ca8-78f8-b866-52f8a1ceae2b",
#     "event_type": "USER_LOGIN",
#     "instance_type": "user",
#     "instance_id": "42",
#     "rendered": "User igor logged in."
#   }
# … and the stream client printed:
#   memento.welcome
#   memento.event.new igor User igor logged in.
```

Read it back: the entity's history (in Serbian here), and the UDC `events` collection with a
filter:

```sh
curl -s 'localhost:9300/memento/entities/user/42/events?locale=sr' -H "Authorization: Bearer $KEY" \
    | jq -c '[.data[] | {event_type, actor_id, rendered}]'
#   [{"event_type":"USER_LOGIN","actor_id":"igor","rendered":"Korisnik igor se prijavio."}]

curl -s localhost:9300/memento/udc/list -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"collection":"events","filter":{"field":"actor_id","op":"eq","value":"igor"}}' \
    | jq -c '.payload | {total, rows: [.rows[] | {event_type, instance_id, actor_id}]}'
#   {"total":1,"rows":[{"event_type":"USER_LOGIN","instance_id":"42","actor_id":"igor"}]}

ls -la data
#   -rw-r--r-- 1 digital digital 217088 Nov 16 01:06 memento.db
#   -rw-r--r-- 1 digital digital  32768 Nov 16 01:06 memento.db-shm
#   -rw-r--r-- 1 digital digital  45352 Nov 16 01:06 memento.db-wal
```

From here the API is the one in [API.md](API.md), and the README's quick start works with
`localhost:9300` in place of `localhost:8000`. Stop the server with `Ctrl-C` (`SIGINT`) or
`SIGTERM`. It closes the database cleanly, and `memento.db-wal` and `memento.db-shm` disappear:

```sh
ls -la data          # after the server stopped
#   -rw-r--r-- 1 digital digital 217088 Nov 16 01:07 memento.db
```

## The image on SQLite

The image is the same one as on PostgreSQL ([DEPLOYMENT.md § The image](DEPLOYMENT.md#the-image)):
the server, the `memento` CLI and the bundled vocabulary, running as the unprivileged `node`
user, with `/data` as its volume. On SQLite it needs a volume and `DATABASE_URL=file:/data/…`,
and no `postgres` or `redis` service. Until the release ([note above](#running-jsmemento-on-sqlite)),
build the image from the repository; this run did:

```sh
docker build -t jsmemento:local .                  # from the repository root
docker run -d --name memento-sqlite -p 9310:3000 -v memento-sqlite-data:/data \
    -e DATABASE_URL=file:/data/memento.db jsmemento:local
docker logs memento-sqlite
#   {"level":30,…,"database":"SQLite /data/memento.db","msg":"database migrated and open"}
#   {"level":30,…,"path":"/app/config/lookups.yaml","sections":["EventTypes","InstanceTypes","ActorTypes"],"strict":false,"msg":"lookups loaded"}
#   {"level":30,…,"path":"/app/config/menu.yaml","msg":"serving the menu UDC collection"}
#   {"level":30,…,"root":"/app/ui","msg":"serving the web UI at / and /en/"}
#   {"level":30,…,"msg":"Server listening at http://127.0.0.1:3000"}
```

After the release, use `ghcr.io/digital-cube/jsmemento:<version>` in place of `jsmemento:local`.
The CLI inside the container reads the same `DATABASE_URL`:

```sh
docker exec memento-sqlite memento create-tenant acme --name "Acme Inc"
#   created tenant acme (Acme Inc) id=01a1e1e7-b29f-7922-8cb1-1488ffcd465b
docker exec memento-sqlite memento create-key --tenant acme --scopes read,write --name backend
#   created key "backend" for acme [read,write]
#   prefix: wczorfqu
#   key:    mk_wczorfqu_gWcO7Rd7vs7fHNyL2GNXmWMGMdp9d8ll
#   Store it now: it cannot be shown again.
KEY=mk_wczorfqu_gWcO7Rd7vs7fHNyL2GNXmWMGMdp9d8ll

curl -s 127.0.0.1:9310/memento/api/health
#   {"ok":true,"data":{"status":"ok"}}
curl -s -X POST 127.0.0.1:9310/memento/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}' \
    | jq -c '.data | {event_type, rendered}'
#   {"event_type":"USER_LOGIN","rendered":"User igor logged in."}
curl -s '127.0.0.1:9310/memento/entities/user/42/events?locale=sr' -H "Authorization: Bearer $KEY" | jq -r '.data[].rendered'
#   Korisnik igor se prijavio.

docker exec memento-sqlite ls -la /data
#   drwxr-xr-x 2 node node   4096 Nov 16 01:03 candidates
#   -rw-r--r-- 1 node node   4096 Nov 16 01:10 memento.db
#   -rw-r--r-- 1 node node  32768 Nov 16 01:10 memento.db-shm
#   -rw-r--r-- 1 node node 296672 Nov 16 01:10 memento.db-wal
```

(The run used `127.0.0.1`: on this host `localhost` resolves to `::1` first, and the container
runtime published the port on IPv4 only.) `/data/candidates` holds the lookup candidates the
server records; it is not part of the database. After `docker stop`, the volume holds
`memento.db` alone.

The same with Compose: one service, one volume, nothing else. Write it as its own file in its
own directory. The repository's `docker-compose.yaml` is the PostgreSQL stack, and its
`name: jsmemento` is the project a second stack on the same host must not reuse. Check the
project name before `up`:

```yaml
# compose.yaml: memento on one SQLite file, no postgres and no redis service.
name: memento-sqlite

services:
  memento:
    image: ${MEMENTO_IMAGE:-ghcr.io/digital-cube/jsmemento:latest}
    restart: unless-stopped
    environment:
      DATABASE_URL: file:/data/memento.db
      # REDIS_URL unset: the /ws stream, the rate limits and the quotas live in this process.
    ports:
      - "${MEMENTO_PORT:-3000}:3000"
    volumes:
      - memento-data:/data

volumes:
  memento-data:
```

```sh
export COMPOSE_PROJECT_NAME=memento-sqlite MEMENTO_IMAGE=jsmemento:local MEMENTO_PORT=9310
docker compose config | grep '^name:'
#   name: memento-sqlite
docker compose up -d
#    Container memento-sqlite-memento-1  Started
docker compose exec -T memento memento create-tenant acme --name "Acme Inc"
#   created tenant acme (Acme Inc) id=01a1e1e7-ff66-7025-8914-38de77fa49d2
curl -s 127.0.0.1:9310/memento/api/health
#   {"ok":true,"data":{"status":"ok"}}
```

Never run a second container on the same volume with its own server in it (such as the
repository's `service`). That is a second server process on the file
([below](#accounts-and-the-service-site)). A container that runs a CLI command and exits is
fine.

## Embedded: the plugin in your application

`mementoPlugin` (`packages/server/src/app.ts`) mounts every route inside your own Fastify
application. The application owns the database handle: `connect()` picks SQLite from the
`file:` URL, `runMigrations()` brings the file up to date, and the plugin receives the `db`.
With one process and no Redis, a `LocalBus` is both the publisher and the stream's feed. This
complete application keeps its events in `data/desk.db`. On its first start it creates its
tenant and a key:

```sh
mkdir ticket-desk && cd ticket-desk && npm init -y && npm pkg set type=module
npm install fastify@5 @memento/server     # before the release: the tarballs, as above
```

```js
// app.mjs: a host application with memento mounted under /memento, on one SQLite file.
import Fastify from "fastify";
import {
  connect,
  createApiKey,
  createTenant,
  LocalBus,
  listTenants,
  mementoPlugin,
  runMigrations,
} from "@memento/server";

// file: → SQLite (WAL, one writer). The application owns the handle and closes it.
const database = connect(process.env.DATABASE_URL ?? "file:data/desk.db");
await runMigrations(database.db); // creates data/desk.db on the first start

// First start: the application's tenant and the key its frontend will use.
if (!(await listTenants(database.db)).some((tenant) => tenant.slug === "desk")) {
  await createTenant(database.db, { slug: "desk", name: "Ticket desk" });
  const { key } = await createApiKey(database.db, {
    tenant: "desk",
    name: "desk-frontend",
    scopes: ["read", "write"],
  });
  console.log(`tenant "desk" created; its API key (shown once): ${key}`);
}

// One process, no Redis: what it stores, it publishes to /ws itself.
const bus = new LocalBus();

const app = Fastify({ logger: { level: "warn" } });
app.get("/", async () => ({ app: "ticket desk", events: "/memento" }));
await app.register(mementoPlugin, {
  prefix: "/memento",
  db: database.db,
  publisher: bus,
  stream: { feed: bus },
});
app.addHook("onClose", async () => {
  await bus.close();
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: "127.0.0.1", port });
console.log(`listening on http://127.0.0.1:${port}`);
```

```sh
PORT=9320 node app.mjs
#   tenant "desk" created; its API key (shown once): mk_07qij36a_or8oLFGEJr916Gdy72vt9T5jRpOZX6rG
#   listening on http://127.0.0.1:9320
```

In a second terminal:

```sh
export KEY=mk_07qij36a_or8oLFGEJr916Gdy72vt9T5jRpOZX6rG
curl -s localhost:9320/
#   {"app":"ticket desk","events":"/memento"}
curl -s localhost:9320/memento/api/health
#   {"ok":true,"data":{"status":"ok"}}

node -e 'const ws = new WebSocket("ws://localhost:9320/memento/ws", ["memento.v1", `bearer.${process.env.KEY}`]); ws.onmessage = (m) => { const msg = JSON.parse(m.data); console.log(msg.kind, msg.payload.rendered ?? ""); if (msg.kind === "memento.event.new") ws.close(); }' &
curl -s -X POST localhost:9320/memento/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"event_type":"TICKET_CREATED","instance_type":"ticket","instance_id":"T-1","actor_id":"ana","payload":{"title":"CSV export drops the last row"}}' \
    | jq -c '.data | {event_type, instance_type, instance_id, rendered}'
#   {"event_type":"TICKET_CREATED","instance_type":"ticket","instance_id":"T-1","rendered":"ana created ticket T-1: \"CSV export drops the last row\"."}
# … and the stream client printed:
#   memento.welcome
#   memento.event.new ana created ticket T-1: "CSV export drops the last row".

curl -s localhost:9320/memento/entities/ticket/T-1/events -H "Authorization: Bearer $KEY" | jq -c '[.data[] | .event_type]'
#   ["TICKET_CREATED"]
DATABASE_URL=file:data/desk.db npx memento list-tenants      # the CLI, next to the application
#   desk	Ticket desk	active
ls data
#   desk.db  desk.db-shm  desk.db-wal
```

After `Ctrl-C`, only `desk.db` remains. A second `node app.mjs` finds the tenant and prints no
new key, only `listening on http://127.0.0.1:9320`.

Notes on embedding:

- Your application **is** the one server process the file allows. Do not also run
  `dist/server.js` on the same file. You may run `memento` CLI commands next to it.
- A process speaks one dialect: `connect()` refuses a PostgreSQL URL while a SQLite handle is
  open in the same process, and the other way round.
- The rest of what the plugin takes (`lookups`, `defaultLocale`, `renderer`, `accounts`,
  `menu`, `udc`, `capabilities`) is in `MementoPluginOptions`, and works the same on both
  databases.
  `buildApp()` is the standalone server without your own routes (what `dist/server.js` runs).

## Without Redis, and with it

On SQLite, `REDIS_URL` stays unset. Everything that would go through Redis runs in the one
process:

| | `REDIS_URL` unset (the SQLite default) | `REDIS_URL` set |
|---|---|---|
| a stored event → `/ws` clients | the in-process `LocalBus`: the process streams what it stores | `RedisPublisher` → `memento:events:<tenant>` → `RedisFeed` in every process |
| rate limits of `/auth/*` (accounts on) | in the process's memory | counters in Redis |
| today's quota count per limited API key | today's `memento_apikey_usage` rows plus the unflushed buffer (flushed every 5 s) | `memento:quota:<key>:<day>` in Redis |
| the usage meter (`memento_apikey_usage`) | written every 5 s and on shutdown | the same |

The server's log says which it uses when accounts are on:
`"rate_limit_store":"memory","quota_store":"usage table"` (shown in the
[next section](#accounts-and-the-service-site)). With one process, nothing is lost by this: the
stream sees every event, and the quota count is exact.

`REDIS_URL` **is accepted** on SQLite: the stream, the rate limits and the quota counters then
go through Redis, as on PostgreSQL. But it does **not** lift the one-process limit. The file
still has one writer, and the queue that orders writes lives inside one process. A second
server process would only wait for the file's write lock on a timer, and a request that gets no
turn in 10 s fails. That setup is neither tested nor supported. For more than one server
process, use PostgreSQL.

## Accounts and the service site

**What works on SQLite:** all of self-service accounts (`MEMENTO_ACCOUNTS=true`). That is
registration, the verify and reset mails (Brevo, or logged without a key), sessions, API keys
users create, pause and delete, daily quotas and usage per hour, the service site's
collections (`api_keys`, `api_key_events`, `api_key_activity`, `api_key_usage`, `admin_users`,
…), and the user commands of the CLI (`list-users`, `make-admin`, `disable-user`,
`verify-user`). The rules are the ones in [DEPLOYMENT.md § Self-service accounts](DEPLOYMENT.md#self-service-accounts).

**What does not:** the way `docker-compose.yaml` runs the service site. There it is a second
server container, `service`, on the same database as `memento`. On SQLite that would be two
server processes on one file, which is not supported ([below](#limits-and-known-differences)).

**What a SQLite installation can do today:** run its one process as the service site instead
of the examples site. One server serves one UI directory (`MEMENTO_UI_DIR`) and one menu
(`MEMENTO_MENU_PATH`). The API under `/memento` is the whole API either way, so the service
site's keys push and read events on the same process. These are the same variables the
`service` container sets:

| variable | the examples site (image default) | the service site |
|---|---|---|
| `MEMENTO_UI_DIR` | `/app/ui` | `/app/ui-service` |
| `MEMENTO_MENU_PATH` | `/app/config/menu.yaml` | `/app/config/menu-service.yaml` |
| `MEMENTO_ACCOUNTS` | off | `true` |
| `MEMENTO_SERVICE_URL` | — | the site's public origin (links in mails); required with accounts |
| `MEMENTO_TRUST_PROXY` | off | `true` behind a proxy that sets `X-Forwarded-*`, only then |

This run used the volume of the image run above, with the `acme` tenant and its CLI key already
in it:

```sh
docker run -d --name memento-sqlite -p 9310:3000 -v memento-sqlite-data:/data \
    -e DATABASE_URL=file:/data/memento.db \
    -e MEMENTO_UI_DIR=/app/ui-service -e MEMENTO_MENU_PATH=/app/config/menu-service.yaml \
    -e MEMENTO_ACCOUNTS=true -e MEMENTO_SERVICE_URL=http://127.0.0.1:9310 \
    jsmemento:local
docker logs memento-sqlite | grep -E 'menu|accounts|web UI'
#   {"level":30,…,"path":"/app/config/menu-service.yaml","msg":"serving the menu UDC collection"}
#   {"level":30,…,"service_url":"http://127.0.0.1:9310","mail":"log","rate_limit_store":"memory","quota_store":"usage table","default_daily_limit":100000,"msg":"self-service accounts on: /auth/* and the session cookie"}
#   {"level":30,…,"root":"/app/ui-service","msg":"serving the web UI at / and /en/"}
```

What the site does when somebody registers, creates a key and uses it, as protocol calls:

```sh
B=127.0.0.1:9310/memento
curl -s $B/auth/register -H 'content-type: application/json' -c jar.txt \
    -d '{"email":"ana@example.com","password":"correct horse battery","name":"Ana","terms":true}' \
    | jq -c '.data | {user: .user.email, verified: .user.email_verified, tenant: .tenant.slug}'
#   {"user":"ana@example.com","verified":false,"tenant":"t-gpyye7es"}
docker logs memento-sqlite 2>&1 | grep -o 'http://127.0.0.1:9310/verify/[A-Za-z0-9_-]*'   # no Brevo key: the mail is logged
#   http://127.0.0.1:9310/verify/aU53onTtu-x7Bv7snDFORtbEPVMoLSNo-yqVlsBJoPM
curl -s $B/auth/verify -H 'content-type: application/json' -d '{"token":"aU53onTtu-x7Bv7snDFORtbEPVMoLSNo-yqVlsBJoPM"}' \
    | jq -c '.data.user | {email, email_verified}'
#   {"email":"ana@example.com","email_verified":true}

curl -s $B/keys -b jar.txt -H 'content-type: application/json' -d '{"name":"vault","scopes":["read","write"]}' \
    | jq -c '.data | {key, status: .api_key.status}'
#   {"key":"mk_5powt12y_mJvp68hhIZSnGxGVEqVRfPFVStgorlMW","status":"active"}
curl -s -X POST $B/events -H "Authorization: Bearer mk_5powt12y_mJvp68hhIZSnGxGVEqVRfPFVStgorlMW" \
    -H 'content-type: application/json' -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":7,"actor_id":"ana"}' \
    | jq -c '.data | {event_type, rendered}'
#   {"event_type":"USER_LOGIN","rendered":"User ana logged in."}
curl -s $B/udc/list -b jar.txt -H 'content-type: application/json' -d '{"collection":"api_keys"}' \
    | jq -c '.payload.rows[] | {name, status, used_today, events_24h}'
#   {"name":"vault","status":"active","used_today":1,"events_24h":1}

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -H 'accept: text/html' 127.0.0.1:9310/keys   # the site's page
#   200 text/html; charset=utf-8
curl -s -H "Authorization: Bearer $KEY" 127.0.0.1:9310/memento/entities/user/42/events | jq -c '[.data[] | .event_type]'   # the CLI key of acme, still valid
#   ["USER_LOGIN"]
docker exec memento-sqlite memento make-admin ana@example.com
#   admin: ana@example.com
```

**Both sites from one process is not possible today.** `MEMENTO_UI_DIR` names one directory and
`MEMENTO_MENU_PATH` one menu, and nothing serves a second pair. An installation on SQLite
chooses one. For a customer's own machine that is the service site: the examples site is a set
of demos (its CPU monitor and activity feed need the `demo` pushers of
[DEPLOYMENT.md](DEPLOYMENT.md#demo-pusher-profile-demo)). On the service site, as on
PostgreSQL, the key page polls its collections every 10 s instead of using the stream
(`/memento/ws` takes an API key, the site has only the cookie).

## The CLI next to a running server

The commands that open the database (`migrate`, `create-tenant`, `create-key`, `revoke-key`,
`retention`, the user, template and chat commands; [CLI.md](CLI.md)) are a second process on the
file, for a moment. That is allowed on the same host. `tail`, `cpu-monitor` and `simulate` talk
to the server over HTTP and open no file. With the quick start's server running:

```sh
npx memento create-key --tenant acme --scopes read --name reports
#   created key "reports" for acme [read]
#   prefix: 9dqb3o0j
#   key:    mk_9dqb3o0j_4K6iSKURCQKT9VyGVpzceiccHJzHSqje
#   Store it now: it cannot be shown again.
npx memento list-tenants
#   acme	Acme Inc	active
```

The key works on the server at once. When the server is in the middle of a write, the CLI waits
for the file's write lock on a timer, up to 10 s. The server goes on serving meanwhile: it waits
the same way for the CLI, without blocking its event loop. To see the wait, another process
holds the write lock for 3 s here:

```sh
node -e 'const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]); db.exec("BEGIN IMMEDIATE"); console.log("lock held"); setTimeout(() => { db.exec("COMMIT"); console.log("lock released"); }, 3000)' data/memento.db &
time npx memento create-tenant globex --name Globex
#   lock held
#   lock released
#   created tenant globex (Globex) id=01a1e1e4-b27b-7de3-8b3f-9e31f36bd4f7
#   real 2.86 s
curl -s localhost:9300/memento/api/health
#   {"ok":true,"data":{"status":"ok"}}
```

A command that gets no turn in 10 s exits with
`SQLite /path/memento.db is busy: another process held its write lock too long` and the hint
`retry in a moment` ([CLI.md § Errors](CLI.md#errors)).

### Retention from cron

`memento retention` archives the events older than each tenant's `retention_days`
([DEPLOYMENT.md § Retention](DEPLOYMENT.md#retention)). Every batch of 10 000 is one statement,
so the server's writes take turns between the batches. A tenant keeps everything until its
`retention_days` is set. No CLI command sets it; on SQLite, use the `sqlite3` shell or Node:

```sh
# an event from September, to have something to archive
curl -s -X POST localhost:9300/memento/events -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor","occurred_at":"2026-09-01T08:00:00Z"}' \
    | jq -c '.data | {occurred_at, received_at}'
#   {"occurred_at":"2026-09-01T08:00:00.000Z","received_at":"2026-11-16T01:06:58.261Z"}

node -e 'const [file, slug, days] = process.argv.slice(1); new (require("node:sqlite").DatabaseSync)(file).prepare("UPDATE memento_tenant SET retention_days = ? WHERE slug = ?").run(Number(days), slug)' \
    data/memento.db acme 30
# or: sqlite3 data/memento.db "UPDATE memento_tenant SET retention_days = 30 WHERE slug = 'acme'"

npx memento retention --dry-run
#   acme: would archive 1 events older than 30 days (before 2026-10-17T01:07:00.171Z)
```

Run it once a day from the crontab of the user memento runs as. cron starts with an almost
empty environment, so give `DATABASE_URL` in the line and name `node` by its path (the `memento`
script starts with `#!/usr/bin/env node`):

```sh
# crontab -e
15 3 * * *  cd /srv/memento && DATABASE_URL=file:data/memento.db /usr/bin/node node_modules/.bin/memento retention >> retention.log 2>&1
```

The same command, run the way cron runs it (no environment but `PATH=/usr/bin:/bin`), next to
the running server:

```sh
env -i PATH=/usr/bin:/bin sh -c 'cd …/my-memento && DATABASE_URL=file:data/memento.db …/bin/node node_modules/.bin/memento retention'
#   acme: archived 1 events older than 30 days (before 2026-10-17T01:07:01.705Z)
```

In the image, the host's crontab runs it in the container:
`docker exec memento-sqlite memento retention` (or `docker compose exec -T memento memento retention`,
which answered `no tenant has retention_days: nothing archived` in the Compose run above).

## Operations

**The files.** `memento.db` is the database. While a process has it open, `memento.db-wal` (the
write-ahead log) and `memento.db-shm` (shared memory for the processes on this host) sit next to
it. They are part of the database: never delete them while the server runs, and never copy
`memento.db` alone while they exist. A clean stop folds the log back into `memento.db` and
removes both. Keep the database on a local disk. In the image that is the `/data` volume
(`DATABASE_URL=file:/data/memento.db`), next to `/data/candidates`. Do not put it in a
bind mount on a network share either.

**Permissions.** The file holds every event, the API keys' hashes, the users' e-mail addresses
and password hashes, and the session hashes. It is created with the process's umask
(`-rw-r--r--` above), so make the directory private: run memento as its own user and
`chmod 700` the data directory. SQLite creates the `-wal` and `-shm` files next to the
database, so that directory must be writable for the server and for the CLI. Run both as the
same user. In the image both are the `node` user, and `/data` belongs to it.

**Backup.** Everything durable is in the file; there is no second store to copy with it. Two ways:

- **While it runs:** `VACUUM INTO` writes a consistent, compacted copy into a new file. With
  Node (the one memento runs on):

  ```sh
  mkdir -p backup
  node -e 'const [from, to] = process.argv.slice(1); new (require("node:sqlite").DatabaseSync)(from).prepare("VACUUM INTO ?").run(to)' \
      data/memento.db backup/memento-$(date +%F).db
  ls -la backup
  #   -rw-r--r-- 1 digital digital 217088 Nov 16 01:07 memento-2026-11-16.db
  node -e 'const db = new (require("node:sqlite").DatabaseSync)(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT (SELECT count(*) FROM memento_event) AS events, (SELECT count(*) FROM memento_tenant) AS tenants, (SELECT integrity_check FROM pragma_integrity_check) AS integrity").get())' \
      backup/memento-$(date +%F).db
  #   [Object: null prototype] { events: 2, tenants: 2, integrity: 'ok' }
  ```

  (Two events: the archived one is still a row.) With the `sqlite3` shell, the same is one
  line. This run used sqlite 3.53.4 from a container, on the image run's volume, while the
  server was running:

  ```sh
  sqlite3 /data/memento.db "VACUUM INTO '/backup/memento-sqlite3.db'"
  sqlite3 /backup/memento-sqlite3.db "SELECT count(*) FROM memento_event; PRAGMA integrity_check;"
  #   1
  #   ok
  ```

  In the image, run the Node line in the container and copy the result out:
  `docker exec memento-sqlite node -e '…' /data/memento.db /data/memento-$(date +%F).db`, then
  `docker cp memento-sqlite:/data/memento-$(date +%F).db .`. The target file must not exist yet.
- **While it is stopped:** stop the server, then copy `memento.db`. After a clean stop there is
  no `-wal` or `-shm`; if there is one, copy it with the file.

`/data/candidates` (the image) is review material for the vocabulary, not data. Copy it if you
review candidates.

**Restore.** Stop the server. Put the copy in place as `memento.db`, with no stale `-wal` or
`-shm` next to it, then start the server. This run restored the `VACUUM INTO` copy above. A
`USER_LOGOUT` pushed after the backup is gone, as it should be:

```sh
mv data/memento.db data/memento.db.old && cp backup/memento-2026-11-16.db data/memento.db
PORT=9300 node node_modules/@memento/server/dist/server.js &
curl -s localhost:9300/memento/entities/user/42/events -H "Authorization: Bearer $KEY" | jq -c '[.data[] | .event_type]'
#   ["USER_LOGIN"]
```

**Upgrades.** Back up first. A new server applies the pending migrations of
`drizzle-sqlite/` (shipped in `@memento/server`) at start, before it listens. `memento migrate`
does the same by hand. Migrations are forward-only, so rolling back means restoring the backup.

**What not to do:**

- **Do not put the file on NFS, SMB or any other network file system.** SQLite's locking is
  not reliable there, and the database gets corrupted.
- **Do not open the file from two hosts.** The locks and the `-shm` shared memory exist only
  within one machine. Two containers on one host sharing the `/data` volume share them; a
  process on another machine does not.
- **Do not start a second server process on the file.** Nothing stops you, and it starts and
  answers health: this was tried. But each process streams only what it stored itself, and a
  `/ws` client connected to one never saw an event pushed to the other. Each process also
  keeps its own rate limits and quota buffer. With Redis the stream would cross, but the setup
  is still not supported ([above](#without-redis-and-with-it)). Use PostgreSQL for more than
  one server.
- **Do not delete `-wal` / `-shm`** while a process has the file open, and do not restore a
  `memento.db` next to stale ones.
- **Do not use `:memory:`** outside tests. It is one process's private database: the server
  starts and answers on it, but every CLI command opens a new, empty one
  (`error: the database has no memento tables yet`), and everything is gone at exit.

## Limits and known differences

- **One server process on one host.** This is the price of having no database service. There
  is no failover and no horizontal scaling.
- **One writer at a time.** Every transaction is `BEGIN IMMEDIATE`, and the server's writes take
  turns behind one gate in arrival order. Reads outside a transaction use a second, read-only
  connection and do not wait. A write that gets no turn within 10 s fails its request (`500`).
  With one server and short CLI commands that should not happen. A CLI command waits up to
  10 s too.
- **The service site or the examples site**, one per process
  ([above](#accounts-and-the-service-site)), not both.
- **Boolean UDC fields** (`is_admin`, `email_verified`, `disabled` in the service site's admin
  collections) are stored as 0/1. They filter on `true` / `false` (or `"true"` / `"false"`) and
  read back as booleans, on both databases. Any other value is a `validation_error`.
- **Case-insensitive matches** (`contains` and the other case-insensitive operators) fold every
  letter, not only ASCII (`Ž` matches `ž`). `starts_with` / `prefix` are case-sensitive, as on
  PostgreSQL.
- **Schema.** The tables are the PostgreSQL ones column for column, in SQLite types: UUIDs as
  lower-case TEXT (an upper-case id in a request still finds its row), timestamps as INTEGER
  epoch milliseconds, JSON and string arrays as JSON TEXT, booleans 0/1. Write SQL of your own
  against them with that in mind ([ARCHITECTURE.md § 3](ARCHITECTURE.md#3-database-schema-postgresql-or-sqlite-drizzle)).
- **Immutable events,** as on PostgreSQL: triggers refuse `DELETE` on `memento_event` and every
  `UPDATE` except archiving. On SQLite the rule is two triggers, and the second one names every
  column of `memento_event`.
- **The `DATABASE_URL` forms** are `file:<path>`, `file:///abs/path` and `:memory:`. A `file:`
  URL with a host (`file://host/…`) or with SQLite URI parameters (`file:x.db?mode=ro`) is refused.
- **The E2E suite** (`pnpm test:e2e`) runs two server processes against PostgreSQL and Redis,
  so it has no SQLite mode. The server's and the CLI's suites run on both databases
  ([CONTRIBUTING.md](CONTRIBUTING.md#running-checks)).

## Moving between the databases

There is **no tool yet** to move an installation from SQLite to PostgreSQL or back. There is no
export or import of the rows, and the two migration sets (`drizzle/`, `drizzle-sqlite/`) are not
interchangeable. Pick the database when you install. If a SQLite installation outgrows one
process, the way today is a new PostgreSQL installation with the events pushed into it again
through the API (`POST /events` keeps `occurred_at`). Event ids, `received_at`, the API keys
(only their hashes are stored), users and sessions do not carry over that way.
