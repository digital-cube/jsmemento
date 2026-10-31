# React UI — `@memento/react` (Phase 5)

Components for browsing a tenant's events in a React app: a live table, a chat, and a search
form. They read through the HTTP API and stay current through the WebSocket stream
(`/memento/ws`, [STREAMING.md](STREAMING.md)). Each subscription follows the filters the
user picks. React 18 or 19.

```tsx
import { MementoChat, MementoDataView, MementoProvider, MementoSearch } from "@memento/react";
import "@memento/react/styles.css";

<MementoProvider baseUrl="/memento" apiKey={key}>
  <MementoDataView />                       {/* live table with event / instance type filters */}
  <MementoSearch />                         {/* instance type + id + date range */}
  <MementoChat chatId="chat-123" userId="igor" />
</MementoProvider>
```

The quickest way to see it running is the example app (`apps/example`, below).

## `MementoProvider`

| prop | |
|---|---|
| `baseUrl` | API base URL: `http://localhost:8000/memento`, or `/memento` behind a proxy (same origin; see "CORS" below) |
| `apiKey` | key with `read`; `write` too for `MementoChat` to send |
| `locale?` | render `rendered` in this locale (`sr`, `sr-Latn`, …) in lists and the stream |
| `fetch?`, `WebSocket?` | replace the globals (tests, SSR, polyfills) |
| `reconnect?` | `false`, or `{ initialDelayMs, maxDelayMs }` (default 0.5 s doubling to 15 s) |

`useMemento()` returns `{ client, openStream, baseUrl, apiKey, locale }` for your own components.
`client` is a `MementoClient` from `@memento/core`.

## `MementoDataView` — the event table

Columns: **When** (`occurred_at`), **Event** (`event_type`), **Instance**
(`instance_type / instance_id`), **Actor** (`actor_id`), **What happened** (`rendered`).

- **Sorting:** click a column header; click again to reverse. The default is `occurred_at`,
  newest first. Sorting reorders the loaded rows; it does not fetch again.
- **Filtering:** the *Event* select offers every event type from `lookups.yaml` plus their
  families (`USER_*`, `CHAT_*`, …); the *Instance type* select offers the vocabulary's
  instance types. A change reloads the newest page and re-subscribes `/ws` with the new
  filter.
- **Live:** events stored after the page loads are added at the top without a reload. Each
  one gets a brief highlighter mark, which is turned off under `prefers-reduced-motion`.

| prop | default | |
|---|---|---|
| `title` | `Events` | |
| `eventTypes`, `instanceTypes` | `lookups.yaml` vocabulary | choices of the two filters |
| `initialFilter` | none | `{ event_type?, instance_type? }` to start with |
| `scope` | none | fixed `{ instance_id?, actor_id? }` the user cannot change |
| `limit` | 50 | events loaded first |
| `live` | `true` | `false`: no WebSocket |
| `locale`, `timeZone` | the browser's | how dates and times are shown |

## `MementoChat`

```tsx
<MementoChat chatId="123" userId="igor" displayName={(id) => users[id].name}
             avatarUrl={(id) => users[id].photo} />
```

- Loads the newest 100 messages and shows them oldest first.
- Subscribes to the chat's `CHAT_MESSAGE_SENT` events.
- Sends as `userId`, who must be a participant (`403` otherwise; the error is shown and the draft is kept).
- A sent message appears at once. Its copy from the stream is merged by event id, so it is
  never shown twice.
- Avatars default to initials on a colour derived from the user id.

| prop | default | |
|---|---|---|
| `limit` | 100 | messages loaded first |
| `readOnly` | `false` | `true` or a reason (`"read-only demo key"`): the composer is disabled, the reason is its tooltip, nothing is ever sent |
| `seenMarkers` | `false` | loads the participants (`GET /chats/:id`) and follows `CHAT_MESSAGE_SEEN`: "Seen by …" under the message each *other* participant has read up to (a sender's own watermark on their own message is left out), and a "New messages" divider where `userId`'s unread messages start |
| `systemEvents` | `false` | shows `CHAT_PARTICIPANT_ADDED` as centred lines with memento's `rendered` text (the provider's `locale`) |
| `displayName`, `avatarUrl`, `title`, `locale`, `timeZone` | | as above |

With `seenMarkers` or `systemEvents` the stream subscribes to every event of the chat instead
of `CHAT_MESSAGE_SENT` alone. The examples site's Chat page (`apps/examples`, `/examples/chat`)
uses all three, read-only.

## `MementoSearch`

A form for an entity's history:
- **Instance type** selector.
- **Instance ID**: exact, or a prefix with `*`, e.g. `igor-*`.
- **From** / **To** dates: local calendar days; *To* is inclusive.

The search is sent as a Filter DSL tree to `POST /events/query` (`eventQueryToFilter`), with
the provider's `locale`. Results use the same table. While the range has no end date they
stay live, so new matching events still appear.

| prop | |
|---|---|
| `instanceTypes?` | choices of the type selector (default: the vocabulary) |
| `limit?` | most results (default 100) |
| `search?` | the search shown, when you keep it (e.g. in the URL): `{ instanceType, instanceId, from, to }`, or `null` for none yet; the form follows it. Leave it out and the component keeps it |
| `onSearch?` | called with those values on every valid submit |
| `renderInstance?` | the Instance cell of a result, e.g. a link: `(event) => <a href=…>…</a>` |

`searchQuery(values)` gives the `EventsQuery` a search is made of. The `/examples/search` page
of `apps/examples` shows the tree next to the form.

## Hooks

The components are thin layers over two hooks; use them for your own UI.

```ts
const { events, status, loading, error, liveIds, reload } =
  useMementoEvents({ event_type: "CHAT_*", instance_type: "chat" }, { limit: 100, live: true });
// endpoint: "query" sends the same query as a Filter DSL tree to POST /events/query

const { messages, status, send, sending, error } = useMementoChat("chat-123", "igor");
// + participants (with `seen: true`) and notices (with `system: true`)
const { participants, notices } = useMementoChat("chat-123", "igor", { seen: true, system: true });
```

`status` is `connecting`, `live`, `offline` (dropped, reconnecting), `closed` or `off` (not
streaming). `<StatusIndicator status={status} />` renders it:
- green dot: live;
- amber dot: connecting;
- red dot: offline.

**Filters and the stream.** `GET /events` accepts `prefix*`; the stream matches exactly.
`liveFilter()` (`@memento/core`) splits a query into two parts:
- exact values go to `/ws`;
- `*` prefixes are applied in the browser.

So `CHAT_*` subscribes without an `event_type` and drops non-chat events locally. Events
outside `after`/`before` are dropped the same way.

## Styling

`@memento/react/styles.css` is optional. Every class starts with `memento-`. Theme it by
overriding the custom properties on `.memento`:

```css
.memento {
  --memento-ink: #1c2b2a;        --memento-paper: #eef2f0;   --memento-surface: #f8faf9;
  --memento-rule: #c9d3cf;       --memento-muted: #5e706c;
  --memento-live: #0f8b6c;       --memento-offline: #c2412d; --memento-highlight: #ffe9a8;
  --memento-story-font: Georgia, serif;   /* the "What happened" column and chat text */
}
```

## CORS

The server sends no CORS headers. Serve the UI from the same origin as the API: mount the
memento plugin in your app, or proxy `/memento` (HTTP and WebSocket) as the example app does
with Vite.

## Example app — `apps/example`

```bash
pnpm dev                                    # memento server on :8000 (another terminal)
pnpm memento create-key --tenant acme --scopes read,write --name example-app
cd apps/example
cp .env.example .env.local                  # optional: pre-fill the key, the chat, the server
pnpm dev                                    # http://localhost:5173 — paste the key
```

- Vite proxies `/memento` (REST and `/ws`) to `MEMENTO_SERVER`, default
  `http://localhost:8000`.
- Workspace packages are used from source, so nothing has to be built first.
- The key is kept in `localStorage`.
- Tabs: *Live events*, *Search*, *Chat* (chat id plus who you are in it).
- *Send a test event* pushes a `NOTE`, so you can watch an event arrive. It needs `write`.

## Tests

`pnpm --filter @memento/react test:cov`: Vitest + jsdom + Testing Library. The suite covers:
- mount and render;
- sorting;
- a filter change re-subscribing the WebSocket with the new query;
- real-time rows, through a scripted socket and through a mock `ws` server;
- the chat send/merge flow;
- the search range.

Coverage threshold: 80 %; currently 100 % of lines.
