# memento examples

Every memento example behind one sidebar — the site `examples.stage.memento-service.org`
serves. A Vite + React 19 app on **`@jsudc/react`**: the sidebar is the **`menu` UDC
collection** (the repository's [`menu.yaml`](../../menu.yaml), served by `@memento/server`),
each example is a route, and every list on every page comes from UDC.

![The examples site: sidebar menu and the live CPU monitor](screenshot.png)

| route | page |
|---|---|
| `/` | redirect to the first example, `/examples/cpu-monitor` |
| `/examples/cpu-monitor` | [CPU monitor](#cpu-monitor) |
| `/udc/:collection` | a plain `UdcDataView` of any collection the server lists (`events`, `cpu_load`, `menu`) |
| anything else | redirect to `/` |

The server serves the built site at `/` and at `/en/` (the router's base is `/en` when the page
was opened there), so `…/en/` links keep working.

## Run it

Requires Node 24+, pnpm and the development infrastructure (PostgreSQL + Redis), from the
repository root:

```bash
docker compose up -d                        # PostgreSQL + Redis (compose.yaml)
pnpm install
pnpm db:migrate

# a tenant, a key for the pusher (write) and one for the page (read)
pnpm memento create-tenant demo --name Demo
pnpm memento create-key --tenant demo --scopes write --name cpu-monitor       # prints mk_… once
pnpm memento create-key --tenant demo --scopes read --name examples-demo      # prints mk_… once

# terminal 1: memento on http://localhost:8000/memento, handing the page its demo key
MEMENTO_DEMO_API_KEY=mk_…read… pnpm dev

# terminal 2: one CPU_LOAD event a second
pnpm memento cpu-monitor --interval 1 --tenant demo --key mk_…write…

# terminal 3: the site
cd apps/examples && pnpm dev                # http://localhost:5173
```

The page opens the CPU monitor, already **Live**: with no key of its own it asks
`GET /memento/api/demo` and connects with the server's read-only demo key. Without
`MEMENTO_DEMO_API_KEY` that route answers 404 and the page asks for a key instead.

To run against the Docker stack (`docker-compose.yaml`, memento on :3000), start the page with
`MEMENTO_SERVER=http://localhost:3000 pnpm dev` — or skip Vite: the image serves the built site
at `http://localhost:3000/` (`MEMENTO_UI_DIR=/app/ui`), same origin as the API. Outside Docker:
`pnpm --filter @memento/examples build` and start the server with
`MEMENTO_UI_DIR=apps/examples/dist`.

## The shell

- **Sidebar** (`src/shell/MenuTree.tsx`, `src/shell/menu.ts`, ported from the jsudc example's
  shell): every row of the `menu` collection in one `useUdcAllRows` list, built into a tree;
  the leaf of the current route is highlighted and the way to it opened; what is open is kept in
  `localStorage` (`udc:menu:expanded`). Labels are `translation_key`s read through the site's
  messages (`src/i18n/messages.ts`, en + sr). The `Collections` branch is `udc:collections`,
  resolved by the server: `events`, `cpu_load`, `menu`. Without a key, without a `menu`
  collection, or when it cannot be read, the sidebar shows the built-in Home and
  Examples › CPU monitor entries (`BUILTIN_MENU_ROWS`).
- **Header**: the wordmark, which key is in use (**demo key** · tenant, **your key**, **no
  key**), the language (EN / SR) and **Settings**: API base URL and API key. The demo key is
  shown there, badged; paste your own to replace it (kept in `localStorage`), **Use the demo
  key** forgets yours again.
- **Routes**: react-router with `UdcReactRouterUrlState`, so every `UdcDataView` keeps its
  `?f=` (filter) / `?p=` (page) state in the URL.

## Adding an example

1. A page under `src/examples/<name>/`, routed in `src/App.tsx` (`/examples/<name>`).
2. An entry under `EXAMPLES` in [`menu.yaml`](../../menu.yaml) (`url: /examples/<name>`) and its
   `MENU.<TERM>` label in `src/i18n/messages.ts`. Add the same entry to `BUILTIN_MENU_ROWS`
   only if the site must show it without the server's menu.

## CPU monitor

The whole memento stack in one screen: a CLI pushes this machine's CPU load averages every
second, the server stores them per tenant and serves them as the **`cpu_load` UDC collection**,
and the page draws them with `UdcDataView` (table and chart). The memento WebSocket stream tells
the page when there is a new sample, so the table refreshes with no reload.

```
memento cpu-monitor ──POST /memento/events──▶ memento server ──POST /memento/udc/list──▶ UdcDataView
   (os.loadavg, 1/s)       (API key, write)      (PostgreSQL)   ◀──ws /memento/ws────── (refetch on event)
```

| | |
|---|---|
| **Collection** | `cpu_load` (CPU_LOAD events, load averages as columns, table + chart) or `events` (every event of the tenant) |
| **instance_type** | the filter the view opens with (`instance_type = server`); it shows as a chip in the data view, where it can be changed or removed like any other filter. Empty: all |
| **Status bar** | green **Live** = stream connected and server healthy, amber = connecting, red = offline (the reason is on the right); time of the last event and events per second |

Server and key are the header's settings; `VITE_MEMENTO_API_KEY` in `.env` pre-fills a key for
development (see `.env.example`).

How it is wired:

- **Rows come only from UDC.** The app's `UdcProvider` has a `UdcClient` with
  `httpUrl: "/memento"` and `Authorization: Bearer <key>`, so `UdcDataView` calls
  `POST /memento/udc/describe` and `POST /memento/udc/list`. Filtering, sorting and paging are
  the jsudc filter DSL; there is no hand-written fetch of list data.
- **The stream only says "refetch".** `useLive` (`src/examples/cpu-monitor/live.ts`) subscribes
  to `/memento/ws?event_type=CPU_LOAD&instance_type=server` with `MementoStream` from
  `@memento/core`, and every event invalidates the collection's list queries (at most one
  refetch per 250 ms).
- **The filter is the data view's own.** `src/settings.ts` writes the `instance_type` condition
  into the `?f=` parameter `UdcDataView` reads its filter tree from.

## Develop

```bash
pnpm test          # Vitest + jsdom: menu, settings, demo key, the live hook, the app against a stubbed server
pnpm typecheck
pnpm build         # dist/, served by `pnpm preview` with the same proxy
```
