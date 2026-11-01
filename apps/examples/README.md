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
| `/examples/activity` | [Activity feed](#activity-feed) |
| `/examples/entity` | [Entity timeline](#entity-timeline): the picker |
| `/examples/entity/:instance_type/:instance_id` | the timeline of one instance (`ticket/T-17`, `user/ana`) |
| `/examples/chat` | [Chat](#chat): the simulator's demo room in `MementoChat`, viewed as one participant (`?as=ana`) |
| `/examples/tail` | [Live tail](#live-tail): every frame of `/memento/ws` as it arrives, with the stream's filters in the URL (`?event_type=TICKET_CREATED`) |
| `/examples/search` | [Search](#search): `MementoSearch` next to the Filter DSL JSON it sends to `POST /events/query`, the search in the URL (`?type=ticket&id=T-1`) |
| `/examples/rendering` | [Rendering & translations](#rendering--translations): one event, its bundled EN and SR templates and the sentence memento renders from each (`?type=TICKET_CLOSED`) |
| `/examples/chart` | [Activity chart](#activity-chart): events per minute by type, the `activity` collection drawn by the chart renderer, the window in the URL (`?w=6h`) |
| `/udc/:collection` | a plain `UdcDataView` of any collection the server lists (`events`, `cpu_load`, `activity`, `menu`) |
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

# terminal 2: one CPU_LOAD event a second, and a ticket desk story (+ the chat room) for the feed
pnpm memento cpu-monitor --interval 1 --tenant demo --key mk_…write…
pnpm memento simulate --interval 1 --tenant demo --key mk_…write…

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
  resolved by the server: `events`, `cpu_load`, `activity`, `menu`. Without a key, without a `menu`
  collection, or when it cannot be read, the sidebar shows the built-in Home and
  Examples › CPU monitor entries (`BUILTIN_MENU_ROWS`).
- **Header**: the wordmark, which key is in use (**demo key** · tenant, **your key**, **no
  key**), the language (EN / SR) and **Settings**: API base URL and API key. The demo key is
  shown there, badged; paste your own to replace it (kept in `localStorage`), **Use the demo
  key** forgets yours again.
- **Routes**: react-router with `UdcReactRouterUrlState`, so every `UdcDataView` keeps its
  `?f=` (filter) / `?p=` (page) state in the URL.

## Adding an example

1. A page under `src/examples/<name>/`, routed in `src/App.tsx` (`/examples/<name>`, above the
   `/examples/:slug` route of the planned pages).
2. An entry under `EXAMPLES` in [`menu.yaml`](../../menu.yaml) (`url: /examples/<name>`), its
   `MENU.<TERM>` label (en + sr) in `src/i18n/messages.ts`, and the same entry in
   `BUILTIN_MENU_ROWS` (`src/shell/menu.ts`), which a test keeps equal to menu.yaml.
3. Replacing a planned example: drop its row from `PLANNED_EXAMPLES`
   (`src/examples/planned/planned.ts`) and add its url to `BUILT` in `test/planned.test.tsx`.

## Planned examples

Every example of the series is built: `PLANNED_EXAMPLES` is empty. The mechanism stays for the
next series — an entry in `menu.yaml` whose page does not exist yet routes to
`PlannedExamplePage` (`/examples/:slug`): a "Planned" badge, one paragraph on what the example
will show (`PLANNED_EXAMPLES`, slug → title and summary in EN and SR) and a link back to the
Activity feed. An unknown slug leads to `/`.

## Activity chart

How busy the tenant is, per event type: the server counts the events per minute and per
`event_type` — a new UDC collection, **`activity`** — and the page draws it with
`@jsudc/react`'s **chart renderer**, live.

```
memento simulate / cpu-monitor ──POST /events──▶ memento_event
/examples/chart?w=1h&f=<minute gte …>
  UdcDataView ──POST /udc/list {collection: activity, filter: minute gte T}──▶ memento
              ◀── rows (minute, event_type, count, cpu_load, ticket_created, …) ── SELECT date_trunc('minute', occurred_at),
                                                                                    event_type, count(*) … GROUP BY
              ◀──ws /memento/ws (no filter) ── refetch, at most once per 5 s
```

- **The collection** (`packages/server/src/udc/activity.ts`, `ActivityCollectionSource`): one
  row per (`minute`, `event_type`) bucket of the key's tenant, with its `count`, computed per
  request — no materialised view, no migration. It covers the last 60 minutes unless the filter
  names `minute`; a top-level `minute` condition also bounds the inner query on `occurred_at`,
  so it reads the tenant/time index instead of every event. Filter DSL on any field, sort,
  offset paging, `total` = number of buckets. `CPU_LOAD` is a series like the others (the
  busiest: one a second, ~60/min per monitored server).
- **Why the extra columns.** jsudc's chart takes its series as *fields*, not as the values of
  one field. So each row also carries one integer per event type of `lookups.yaml`
  (`cpu_load`, `ticket_created`, …, plus `other` for types outside it): the bucket's count
  under its own type, 0 under the rest. The view's chart sums each per point, which is that
  type's count in that minute — or in the wider bucket the chart picks when a long window
  (24 h) has more minutes than pixels. The table shows them too, as a pivot next to
  `minute` / `event_type` / `count`.
- **The view**: chart tab first (a line per type, `y` from zero), then the table; an
  `event_type` select filter. The same rows open as a plain table from the sidebar's
  Collections branch (`/udc/activity`).
- **Window selector** (15 min / 1 h / 6 h / 24 h, `src/examples/chart/chart.ts`): writes
  `minute gte <start>` into the data view's `?f=` (it shows as a chip, like the CPU monitor's
  `instance_type`) and the choice into `?w=`; chips the visitor added are kept. The start is
  the last N whole minutes, the current one included, and **slides**: at every whole minute
  the page rewrites it, unless the visitor removed the chip.
- **The last point is the current minute**, still filling up: its counts grow with every
  refetch, so the lines dip at the right edge (the page's note says so).
- **Live**: `useLive` follows the whole stream; every event refetches the collection's lists,
  at most once per 5 s (`CHART_REFRESH_MS`) — a bucket changes once a minute, there is no
  need for the 250 ms of the other pages.

## Rendering & translations

How memento turns an event into a sentence (docs/TEMPLATES.md): pick an event type, see the
tenant's latest event of it, the bundled `.en.hbs` and `.sr.hbs` sources, and the sentence the
**server** renders from each, side by side.

```
packages/server/templates/*.hbs ──import.meta.glob(?raw), at build time──▶ templates.ts (type → {en, sr})
/examples/rendering?type=TICKET_CLOSED
  latest event   ──POST /udc/list {collection: events, filter: event_type eq T, limit 1}──▶ memento
  rendered (en)  ──POST /udc/read {collection: events, id}  X-Memento-Locale: en ─────────▶ memento
  rendered (sr)  ──POST /udc/read {collection: events, id}  X-Memento-Locale: sr ─────────▶ memento
```

- **Template sources are the server's files.** `src/examples/rendering/templates.ts` imports
  every `packages/server/templates/*.hbs` with Vite's `import.meta.glob(…, {query: "?raw"})`
  and maps them `event_type → {en, sr}` (`_generic` apart). There is no endpoint for template
  sources; a **tenant override** lives in the database (`memento_template`) and is not visible
  here — the page says so and shows the command that would create one,
  `pnpm memento create-template --tenant <tenant> --event-type T --locale sr --file T.sr.hbs`.
- **Type selector**: exactly the types with a bundled template (alphabetical), each with how
  many events of it the tenant has (the `total` of a 1-row `events` list); the empty ones are
  greyed but still open their templates. The type is in the URL (`?type=`), default
  `TICKET_CREATED`.
- **Three columns**: the latest event of the type (fields, the instance linking to its
  [timeline](#entity-timeline), the payload pretty-printed), then per locale the template
  source and the rendered sentence. The sentences are **not** a Handlebars run in the browser:
  the page reads the same event twice through UDC, with clients whose `X-Memento-Locale` is
  `en` and `sr` (`mementoUdcClient`, `src/connection.tsx`). They do not follow the header's
  language — both are always shown.
- **Highlighted keys**: every `payload.<key>` inside a `{{…}}` of either template (output,
  `#if`, a helper's argument — `payloadKeys`) is marked in the template source and in the
  payload pane, so it is visible which members of the payload the sentence uses.
- **Where the template comes from**: the lookup chain for both locales
  (`T.sr → T.en → _generic.sr → _generic.en →` built-in line), the step the bundled files
  answer marked; at every step a tenant's own template beats the bundled one.
- **`_generic`**: its EN and SR source and when it is used — any event type without a template
  of its own. Every type of `lookups.yaml` has a bundled template except `NOTE`, and `NOTE` does
  not go through `_generic` either: its text is `payload.text`, stored verbatim, the same in
  every locale.
- **Live**: `useLive` follows the stream filtered by the picked `event_type`; a new event of the
  type refetches the column and the counts (at most once per 250 ms).

## Search

How a search is expressed: **`MementoSearch`** from `@memento/react` on the left, and on the
right, under **What was sent**, the request it made — read off the wire, not rebuilt.

```
MementoSearch ──POST /memento/events/query {filter: <Filter DSL>, limit: 100, locale: en|sr}──▶ memento
  (type, id, from, to)  ◀── {ok, data: [events, newest first], meta} ──────────────────────────
        │ the same tree, UDC's op names
        ▼
/udc/events?f=<encodeFilterParam(tree)> ──POST /memento/udc/list {collection: events, filter}──▶ memento
```

- **The form is the component's.** Instance type, instance id (exact, or a prefix with `*`:
  `T-1*`), from / to days (*to* inclusive). `MementoSearch` turns them into a Filter DSL tree
  (`eventQueryToFilter` of `@memento/core`: `eq` / `prefix` per field, `occurred_at gte` the
  first day and `lt` the day after the last) and sends it to `POST /memento/events/query`.
  Results are its table; the Instance cell is a chip that links to the instance's
  [timeline](#entity-timeline). While the range has no end the results stay live (the stream).
- **What was sent.** The page gives `MementoProvider` a `fetch` that lets every request
  through and reports each `POST …/events/query` (`tapFetch`, `src/examples/search/search.ts`).
  Three read-only panes follow every search: the **Filter DSL** JSON of the body (pretty, with
  **Copy**; `null` when the search filters on nothing), the **request** as a `curl` command
  against the absolute URL with the key masked (`mk_…9f3a`), and the **response** — HTTP
  status, `ok`, `meta` (memento's list envelope has `count` and `next_cursor`, no `total`) and
  the first row, the rest counted (`… 29 more`).
- **The same filter in UDC.** The `events` UDC collection takes the same tree in
  `POST /memento/udc/list` — conditions `field` / `op` / `value` under `and` / `or` / `not` —
  with three operators spelled UDC's way: `prefix` → `starts_with`, `ne` → `neq`, `nin` →
  `not_in` (and `is_null: false` → `is_not_null`; `toUdcFilter`). **Open in the UDC events
  table** goes to `/udc/events?f=…`, the tree encoded with `encodeFilterParam` of
  `@jsudc/react/headless` (as `src/settings.ts` does for the CPU monitor), so the table opens
  with the same condition as its filter chips. The translated tree is shown under *As a UDC
  filter*.
- **The search is in the URL**: `?type=ticket&id=T-1*&from=2026-10-01&to=2026-10-31`
  (`searchFromParams` / `searchToParams`). `type` is always written by a search (`type=` for
  any type), so a link runs the search on open; browser back restores the previous one, form
  included (`MementoSearch`'s `search` / `onSearch` props keep it outside the component).
- **The language is the header's.** `MementoProvider` gets the site's locale, so the body
  carries `locale: "en" | "sr"` and memento renders `rendered` in it; switching EN / SR sends
  the search again.

## Live tail

`memento tail` in the browser: the page opens `GET /memento/ws` (docs/STREAMING.md) and lists
every frame the socket delivers, as it arrives — not a UDC list, the stream itself, to see how
it works.

```
memento simulate / cpu-monitor ──POST /events──▶ memento ──ws /memento/ws?event_type=…&locale=en──▶ /examples/tail
                                                          ◀── memento.ping (every heartbeat) ───────  MementoStream
                                                          ──── memento.welcome · memento.event.new · memento.pong ──▶
```

- **The stream's own client.** `MementoStream` from `@memento/core` connects (the key as the
  subprotocol `bearer.<key>` next to `memento.v1`, never in the URL), waits for the welcome and
  reconnects with backoff. The page listens in on the socket it opens (`tapWebSocket`,
  `src/examples/tail/tail.ts`), so it sees the raw text of every frame, not only the events
  `MementoStream` hands on.
- **Filter bar**: the stream's filters — event types as a multi-select of memento's vocabulary
  (`EVENT_TYPES`, lookups.yaml), instance type, instance id and actor as text (Enter /
  **Apply**). They live in the page's URL (`?event_type=TICKET_CREATED&instance_id=T-3`), so a
  link reproduces them; every change is a new connection and a fresh list (the stream's filters
  are fixed for the life of a connection). The `ws://…/memento/ws?…` URL the socket opened is
  shown verbatim, to copy. The stream takes **one** `event_type`: with several picked the URL
  has none, every type arrives and the page keeps the picked ones itself (counted as *left out
  by the page*; the page says so). A filter the server would refuse (422, e.g.
  `instance_type=Ticket`) is not connected; the page says why.
- **The language is the header's.** The stream has a `locale` parameter (not a filter): the
  page connects with `?locale=<en|sr>`, so `rendered` comes re-rendered in the header's
  language; switching EN / SR reconnects.
- **Frames**, newest on top, the last 500 kept (`MAX_FRAMES`, oldest dropped). Each row is the
  one-line summary of `memento tail` — `[hh:mm:ss] EVENT_TYPE instance/id — rendered` — and
  opens to the frame's pretty-printed JSON. Everything that is not an event is dimmed and can
  be hidden (**Show control frames**): `memento.welcome` (tenant, filter, heartbeat),
  `memento.pong`, `memento.error`, and the socket closing (not a frame on the wire, noted in
  the list with its code and reason). Heartbeats: the server's WebSocket pings are answered by
  the browser without the page seeing them, so the page sends the stream's `memento.ping` at
  the welcome's `heartbeat_interval_ms` and the `memento.pong` is a row.
- **Controls**: **Pause** keeps receiving in the background and shows *N new while paused*
  (the paused buffer is capped at 500 too); **Resume** puts them on top; **Clear** empties the
  list. Counters: frames received, events/s over the last 10 s, connected since, reconnects.
  The status dot is the CPU monitor's: connecting (amber), live (green), closed (red) with the
  close code and reason, e.g. *Closed 4008 slow consumer*.
- **Not UDC, on purpose**: there is no collection here, only the stream; the frames are not
  persisted.

## Chat

`memento simulate` also plays a chat: the team talks in one room, and the page shows that room
with **`MementoChat`** from `@memento/react` — the component an app would embed — read-only,
live.

```
memento simulate ──POST /chats (once), /chats/chat-demo-room/messages, /seen, /participants──▶ memento
                                                                                                 │
/examples/chat ◀── GET /chats/chat-demo-room?user_id=igor ── participants, read watermarks ──────┤
  MementoChat  ◀── GET /chats/chat-demo-room/messages?user_id=<viewer>&locale=<en|sr> ───────────┤
               ◀── ws /memento/ws?instance_type=chat&instance_id=chat-demo-room ─────────────────┘
```

- **The room.** On start the simulator makes sure `chat-demo-room` ("Demo room") exists,
  creating it with igor, marko, ana and jelena when it is missing (an existing one is reused).
  Its chat scene, weighted like the other scenes: an online member says a short line about the
  tickets the desk is working ("I took T-17.", "Zatvaram T-12, duplicate."), lines alternating
  English and Serbian as people write them (nothing is translated); another member marks the
  newest message seen; rarely somebody of the team is added. `--no-chat` leaves the room alone.
- **Viewed as a participant.** Chat reads are made on behalf of a user (`user_id`, see
  docs/CHATS.md), so the page reads the room as one participant, chosen in the **Viewing as**
  selector on top — the first participant by default, kept in the URL (`?as=ana`). Switching
  the viewer reloads the room as that person: their messages are the "own" ones, the **Seen by**
  markers show where the *other* participants' read watermarks are, and a **New messages**
  divider shows where the viewer's unread messages start.
- **Read-only.** The composer is disabled, its tooltip says *read-only demo key*: the demo key
  has only the `read` scope (the server refuses to hand out anything else), so nothing can be
  sent and nothing is tried. Writing stays with the simulator.
- **Live, over the WebSocket — no polling.** `MementoChat` loads the newest 100 messages and
  then follows the room's events on `/memento/ws`: new messages appear as they are sent, read
  markers move on `CHAT_MESSAGE_SEEN`, "X was added" lines appear on `CHAT_PARTICIPANT_ADDED`.
  The page itself follows the same stream to read the room again when a participant is added
  (the selector grows) or, while the room is missing, when it first speaks.
- **The language is the header's.** `MementoProvider` gets the site's locale: the system lines
  ("mila was added to the chat" / "mila je dodat u čat") are memento's rendered text and switch
  with EN / SR; people's messages stay as written. `MementoChat`'s own few labels are English.
- **Not UDC, on purpose.** Chats are read through memento's chat API rather than a UDC
  collection: every read is checked against the room's participants (`user_id`), which the
  tenant-wide `events` collection does not do. The page reads them only through
  `MementoChat` / `MementoClient`; there is no hand-written fetch.
- **Empty** (the simulator never ran): one sentence and the compose command,
  `docker compose -f docker-compose.yaml --profile demo up -d simulator`. The room appears
  without a reload once the simulator speaks in it.

## Activity feed

The tenant's events as people read them: `memento simulate` plays a small team working a ticket
desk, memento renders every event with its Handlebars template, and the page lists the
sentences, newest first, live.

```
memento simulate ──POST /events──▶ memento ──POST /udc/list {collection: events}──▶ feed
  (a ticket desk, 1 event/3 s)      renders  ◀── X-Memento-Locale: en | sr ────────  (EN / SR)
                                             ──ws /memento/ws─────────────────────▶ refetch
```

- **Rows from UDC.** `useUdcCollection` (`@jsudc/react`) over `events`, filter
  `event_type neq CPU_LOAD`, sorted `occurred_at desc`, infinite paging by offset (30 a page; the
  next page loads when the end of the list scrolls into view, or on **Older events**). Each line:
  time, the actor's initials avatar (`initials` / `hue` of `@memento/react`) and id, the
  **rendered** text, the instance as a chip (`ticket/T-17`) that links to its
  [timeline](#entity-timeline), the event type as a muted tag.
- **The language is the header's.** The app's `UdcClient` sends `X-Memento-Locale: <en|sr>` with
  every request; memento renders `rendered` in it (docs/TEMPLATES.md, "When it happens"). Switching
  EN / SR invalidates every UDC list, so the feed comes back in the other language without a
  reload. The choice is kept in `localStorage` (`udc-locale`).
- **Live.** `useLive` (`src/live.ts`) follows the whole stream; every event that is not a
  `CPU_LOAD` refetches the feed (at most once per 250 ms, `src/refresh.ts`). New lines fade in.
- **Empty** (no simulator running): one sentence on what pushes these events and the compose
  command, `docker compose -f docker-compose.yaml --profile demo up -d simulator`.

## Entity timeline

memento's central question — *what happened to this object?* (docs/PHILOSOPHY.md) — for one
instance: pick `ticket/T-3`, read its create → modify → note → close story, newest on top, live.

```
/examples/entity                      picker: the tenant's instance types, the latest instances
        │ click / type an id                    of the chosen one, with their event counts
        ▼
/examples/entity/ticket/T-3  ──POST /udc/list {collection: events,──▶ memento
                                filter: instance_type = ticket AND instance_id = T-3}
                             ◀──ws /memento/ws?instance_type=ticket&instance_id=T-3── refetch
```

- **The same events as `GET /memento/entities/:instance_type/:instance_id/events`**, read
  through UDC like every list of the site: the `events` collection with an exact `and` of
  `instance_type eq` and `instance_id eq` (`entityFilter`, `src/examples/entity/entity.ts`),
  sorted `occurred_at desc`, infinite offset paging (50 a page, **Older events**). No new
  endpoint, no hand-written fetch.
- **Picker** (`/examples/entity`, `?type=` keeps the chosen type). The types are not a fixed
  list: UDC has no `distinct`, so `scanInstanceTypes` walks them one 1-row list each
  (`instance_type gt <previous>`, sorted ascending) — exact, a handful of requests for the few
  types a tenant has, at most 50. It opens on `ticket` when there is one. For the chosen type,
  the latest 200 events give the 12 most recently active ids (`recentInstances`), each with its
  last activity and its event count — the exact `total` of a 1-row list of its events. **Or
  type one**: any type / id by hand.
- **Timeline**: a vertical line of entries, each with date and time, the actor's avatar, the
  event type tag and the text memento rendered in the header's language (EN / SR, as in the
  feed). On top, the summary: first seen, last seen, event count (the list's `total`) and
  distinct actors (`actors+` while older pages are not loaded; the first event then comes from
  its own 1-row ascending list).
- **Links**: every actor of an entry is another instance, `user/<actor>`, and links to its own
  timeline — except on that user's own timeline. The routes are react-router's, so browser back
  walks the way back to the feed.
- **Live**: `useLive` subscribes to the stream filtered by `instance_type` + `instance_id`;
  every event refetches the timeline (at most once per 250 ms). New entries fade in.
- **Empty** (an instance with no events): says so and links back to the picker on its type.

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
- **The stream only says "refetch".** `useLive` (`src/live.ts`) subscribes
  to `/memento/ws?event_type=CPU_LOAD&instance_type=server` with `MementoStream` from
  `@memento/core`, and every event invalidates the collection's list queries (at most one
  refetch per 250 ms).
- **The filter is the data view's own.** `src/settings.ts` writes the `instance_type` condition
  into the `?f=` parameter `UdcDataView` reads its filter tree from.

## Develop

```bash
pnpm test          # Vitest + jsdom: menu, settings, demo key, the live hook, the feed (locale, live, paging), the entity picker and timeline (order, summary, links, live filter), the chat (viewer selector, seen markers, read-only composer, locale, live, empty room), the live tail (frames, 500 cap, pause, filter reconnect, close code), the search (the DSL pane is the sent body, curl and response panes, the UDC link's equivalent filter, URL state, locale), rendering (every bundled template globbed, the selector's types and counts, highlighted payload keys, one read per locale), the activity chart (window start, the selector writes `?f=` and keeps chips, the 5 s throttle, locale), the planned pages, the app against a stubbed server
pnpm typecheck
pnpm build         # dist/, served by `pnpm preview` with the same proxy
```
