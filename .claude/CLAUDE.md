# jsmemento — Claude Code directives

## UDC-first (target architecture)

Every data collection memento serves — events, chats, entities, anything list-shaped that a
UI filters, sorts or pages — goes through UDC (the DigitalCube Universal Data Collection
protocol) on both sides of the wire:

- **Server:** each collection is a UDC endpoint under `/memento/udc/<collection>`, served by
  `@jsudc/server` (`udcPlugin`, registry, `UdcSource`) and validated by `@jsudc/core` schemas.
- **Client:** React reads collections only through `@jsudc/react` (`UdcProvider`, `UdcClient`,
  `UdcDataView`). No hand-written fetch logic for list data.

Why: one protocol for filtering, sorting and pagination across every DigitalCube project;
one place (jsudc) to fix bugs and add features, which every project then gets on the next
install; this monorepo stays thin because the generic table/query machinery does not live here.

## Current state (2026-10-31) — read before acting

The code does not match the target yet. Do not assume otherwise:

- No package in this monorepo depends on `@jsudc/*` today.
- `packages/react/src/MementoDataView.tsx` is built on `MementoClient` from `@memento/core`
  and the local `EventTable`, not on `@jsudc/react`.
- `packages/server` exposes `/events`, `/events/query`, `/chats`, `/describe`, `/api/health`
  and the WebSocket stream. There is no `/memento/udc/*` route yet.
- `apps/example/src/App.tsx` has one raw `fetch` (POST of a test event).

Migrating these to UDC is the intended direction. When you touch one of these areas, move it
towards UDC instead of extending the custom path. New collections start on UDC from day one.

## Rules

1. **New list data = new UDC collection.** Register it with `@jsudc/server` and expose it under
   `/memento/udc/<collection>`. No bespoke list endpoint.
2. **Filtering, sorting and paging use the jsudc filter DSL and envelope.** No ad-hoc query
   params, no filter logic hardcoded in a component.
3. **React consumes collections through `@jsudc/react` only.** `MementoDataView` and similar
   components are thin wrappers that configure `UdcDataView`, not re-implementations.
4. **Writes that are not UDC actions stay on the memento API** (`POST /events`, chats). UDC is
   the read/collection side.
5. **If jsudc cannot do what memento needs, change jsudc, not memento.** See below.

## Contributing back to jsudc (encouraged)

1. Make the change in the jsudc monorepo (`@jsudc/core`, `@jsudc/server`, `@jsudc/react`),
   with tests, and open a PR there.
2. After merge: version bump and publish to npm.
3. Here: bump the dependency in the affected `package.json`, run `pnpm install` so
   `pnpm-lock.yaml` updates, and commit both.
4. Reference the jsudc PR in the memento commit message.

Never copy jsudc code into this repo and never patch it inside `node_modules`.

## Red flags — stop and reconsider

- ❌ `fetch(` in a React component or hook for list data → `UdcClient` via `@jsudc/react`.
- ❌ A new Fastify route that returns an array of records for a UI table → UDC collection.
- ❌ `?sort=` / `?page=` / per-endpoint filter strings → jsudc filter DSL.
- ❌ Working around a jsudc limitation locally → PR to jsudc.

## Examples

✅ Good — the table is a UDC view, filter/sort/paging come from the protocol
(names per the current `@jsudc/react` README; check them before copying):

```tsx
<UdcProvider client={new UdcClient({ baseUrl: `${baseUrl}/udc`, token: apiKey })}>
  <UdcDataView collection="events" initialFilter={{ event_type: "USER_LOGIN" }} />
</UdcProvider>
```

❌ Bad — manual fetch, invented query params, paging in component state:

```tsx
const [rows, setRows] = useState([]);
useEffect(() => {
  fetch(`${baseUrl}/events?event_type=USER_LOGIN&page=${page}`)
    .then((r) => r.json())
    .then(setRows);
}, [page]);
```

## Versions

Pin to these and bump deliberately (verify with `npm view <pkg> version`):

- `@jsudc/core` 0.2.0
- `@jsudc/server` 0.2.1
- `@jsudc/react` 0.2.1
