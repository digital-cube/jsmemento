# CPU monitor demo

The whole memento stack in one screen: a CLI pushes this machine's CPU load averages every
second, the server stores them per tenant and serves them as the **`cpu_load` UDC collection**,
and this Vite + React app draws them with **`@jsudc/react`** (`UdcDataView`, table and chart).
The memento WebSocket stream tells the page when there is a new sample, so the table refreshes
with no reload.

![Live CPU load table](screenshot.png)

```
memento cpu-monitor ──POST /memento/events──▶ memento server ──POST /memento/udc/list──▶ UdcDataView
   (os.loadavg, 1/s)       (API key, write)      (PostgreSQL)   ◀──ws /memento/ws────── (refetch on event)
```

## Run it

Requires Node 24+, pnpm and the development infrastructure (PostgreSQL + Redis), from the
repository root:

```bash
docker compose up -d                        # PostgreSQL + Redis (compose.yaml)
pnpm install
pnpm db:migrate
pnpm dev                                    # memento on http://localhost:8000/memento

# a tenant, and a key for the monitor (write) and the page (read)
pnpm memento create-tenant demo --name Demo
pnpm memento create-key --tenant demo --scopes read,write --name cpu-monitor   # prints mk_… once

# terminal 2: one CPU_LOAD event a second
pnpm memento cpu-monitor --interval 1 --tenant demo --key mk_…
# ● cpu-monitor: pushing CPU_LOAD for server/<host> every 1s to http://localhost:8000/memento
# [11:23:15]  server/<host>  load 2.77 3.10 2.86  → 50f7b398-…

# terminal 3: the page
cd apps/cpu-monitor && pnpm dev             # http://localhost:5173
```

Paste the key into **API key**, press **Connect**. The header dot turns green (**Live**) once
the WebSocket stream is connected and `/memento/api/health` answers; new rows appear at the
top every second.

To run against the Docker stack (`docker-compose.yaml`, memento on :3000) instead, start the
page with `MEMENTO_SERVER=http://localhost:3000 pnpm dev` and point the CLI at it with
`--url http://localhost:3000/memento`.

## What is on the page

| | |
|---|---|
| **API base URL** | `/memento` goes through the Vite proxy to `MEMENTO_SERVER` (default `http://localhost:8000`); an absolute `http://host:port/memento` works too when the server allows the origin |
| **API key** | a key of the tenant, scope `read` is enough for the page |
| **Collection** | `cpu_load` (CPU_LOAD events, load averages as columns, table + chart) or `events` (every event of the tenant) |
| **instance_type** | the filter the view opens with (`instance_type = server`); it shows as a chip in the data view, where it can be changed or removed like any other filter. Empty: all |
| **Status bar** | green **Live** = stream connected and server healthy, amber = connecting, red = offline (the reason is on the right); time of the last event and events per second |

The settings are kept in `localStorage`; `VITE_MEMENTO_API_KEY` in `.env` pre-fills the key
(see `.env.example`).

## How it is wired

- **Rows come only from UDC.** `UdcProvider` gets a `UdcClient` with
  `httpUrl: "/memento"` and `Authorization: Bearer <key>`, so `UdcDataView` calls
  `POST /memento/udc/describe` and `POST /memento/udc/list`. Filtering, sorting and paging
  are the jsudc filter DSL; there is no hand-written fetch of list data.
- **The stream only says "refetch".** `useLive` (`src/live.ts`) subscribes to
  `/memento/ws?event_type=CPU_LOAD&instance_type=server` with `MementoStream` from
  `@memento/core`, and every event invalidates the collection's list queries (at most one
  refetch per 250 ms).
- **The filter is the data view's own.** `src/settings.ts` writes the `instance_type`
  condition into the `?f=` parameter `UdcDataView` reads its filter tree from.

## Develop

```bash
pnpm test          # Vitest + jsdom: settings, the live hook, the app against a stubbed UDC server
pnpm typecheck
pnpm build         # dist/, served by `pnpm preview` with the same proxy
```
