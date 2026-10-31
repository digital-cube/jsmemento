# JSMemento: Analiza i arhitekturni pregled

> *"Every event deserves to be remembered."*

## 1. Kontekst i cilj

JSMemento je JavaScript/TypeScript port **Memento** projekta (Python/React verzija) — self-hosted activity ledger koji mašinske događaje pretvara u čitljive priče na jeziku krajnjeg korisnika i čuva ih kao imutabilan audit trail.

Za razliku od Python verzije, JSMemento će biti:
- **Čist JavaScript ekosistem** (TypeScript, Node.js/Deno)
- **Modularni npm paketi** (poput `jsudc` modela)
- **Open source** pod MIT licencom (kao `jsudc`)
- **Multideploy** — biblioteka, kontejner, cloud servis sa API ključem

## 2. Analiza memento-spp (Python verzija)

### 2.1 Šta memento radi

Memento je centralna "memorija" za aplikacije:

```
Aplikacija → Memento API → PostgreSQL
             ↓
         Jinja2 templates
         (renderovanje)
             ↓
        Čitljiv event log
        (kraj. korisnik)
```

**Tipična upotreba:**
```bash
# Push event
curl -X POST http://localhost:8000/events \
  -H "Authorization: Bearer mk_..." \
  -H "Content-Type: application/json" \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":"42"}'

# Query entity
curl "http://localhost:8000/entities/user/42/events" \
  -H "Authorization: Bearer mk_..."

# WebSocket stream
ws://localhost:8000/ws?event_type=USER_LOGIN
```

### 2.2 Ključne karakteristike memento-spp

| Feature | Detalj |
|---------|--------|
| **Entitet (instance)** | `instance_type` + `instance_id` (npr. `user/42`, `ticket/777`) |
| **Multitenancy** | Tenant kontekst kroz sve slojeve; stroga izolacija |
| **Imutabilnost** | Eventi se ne menjaju/brišu, samo arhiviraju (soft delete) |
| **Real-time** | WebSocket streaming sa filterima (`/ws?event_type=...`) |
| **Interakcije** | Seen / unseen, star (bookmark) tracking |
| **Template rendering** | Jinja2 šabloni, per-tenant overrides, i18n (locale fallback) |
| **API key auth** | Hešovani ključevi, scope-ovi (`read`, `write`, `admin`), tenant binding |
| **UDC integracija** | Memento kao `UdcSource` — `/udc/list` bridge za tabelu |
| **Admin ops** | Cross-tenant transfer (`POST /admin/transfer`) |

### 2.3 Stack memento-spp

```
Backend:        Python 3.14+, FastAPI, Uvicorn, Tortoise ORM, PostgreSQL, Redis
Frontend demo:  React + Vite, TypeScript, TailwindCSS, shadcn/ui, pnpm
Deployment:     podman-compose (lokalno), Podman (prod)
CLI:            Typer + Rich (tenant/key/template management)
Testing:        pytest + asyncio, coverage > 80%
Template engine: Jinja2
Data validation: Pydantic
Lookups:        dc-lookups (controlled vocabulary, i18n)
UDC integration: udc-py (Python UDC protokol)
```

### 2.4 Arhitektura memento-spp

**Repo struktura:**
```
memento-spp/
├── pyproject.toml          # backend package
├── compose.yaml            # postgres + redis
├── Makefile                # sve komande
├── lookups.yaml            # event types, instance types, actor types
├── src/memento/
│   ├── api/                # FastAPI rute (health, events, entities, /ws, /udc, /admin)
│   ├── core/               # auth, middleware, exceptions, context, logging
│   ├── models/             # Tortoise ORM (Event, Seen, Star, Template, ApiKey, Tenant)
│   ├── cli/                # Typer (create-tenant, create-key, create-template)
│   ├── udc/                # EventSource (UdcSource implementacija)
│   └── templates/          # Jinja2 (.j2 fajlovi)
├── tests/
│   ├── unit/
│   └── integration/
└── frontend/               # React demo (Vite)
    ├── apps/demo/
    └── pnpm-workspace.yaml
```

**Tri "mikroservisa" (opciono razdvajanje):**
- `memento-api` — core API, WebSocket, template rendering
- `memento-files` — attachment upload/download
- `memento-worker` — Celery background taskovi, webhooks

**Baza podataka:**
```sql
memento_tenant          -- tenant data (slug, name)
memento_apikey          -- API keys (hashed, scopes, tenant binding)
memento_event           -- immutable event log (occurred_at, event_type, instance_type, instance_id, actor_id, payload, rendered)
memento_seen            -- read markers (user_id per event)
memento_star            -- bookmarks (user_id per event)
memento_template        -- per-tenant Jinja2 overrides (event_type, locale, body)
memento_schema_revisions -- schema audit trail (ako se prime live schema edits)
```

### 2.5 Životni ciklus eventa u memento-spp

```
1. POST /events
   ↓ (ApiKeyAuth middleware)
2. Validacija (Pydantic + Lookups)
   ↓
3. Persist u memento_event
   ↓
4. WebSocket pub/sub (Redis) — push na aktivne klijente
   ↓
5. Jinja2 render (šablon + i18n fallback)
   ↓
6. GET /events, GET /entities/.../events, /udc/list
   (vrati rendered tekst krajnjem korisniku)
```

### 2.6 Faze razvoja memento-spp

| Faza | Status | Sadržaj |
|------|--------|---------|
| 1 | ✅ | Repo, config, core, Tenant, `/health`, CLI |
| 2 | ✅ | ApiKey auth, Event model, push/query, tenant isolation |
| 2b | ✅ | UDC integracija — MementoEventSource, /udc mount |
| 3 | ✅ | Jinja2 templates, per-tenant overrides, i18n |
| 3a | ✅ | Polish, UDC __meta envelope, locale fallback |
| 4a | ✅ | WebSocket streaming, `/ws` endpoint, slow-consumer detection |
| 4b | ⏳ | Interactions: seen/star |
| 4c | ⏳ | Messages |
| 4d | ⏳ | Python SDK |
| 4e | ⏳ | JS Client SDK |
| 4f | ⏳ | CRUD `/templates` |

---

## 3. Analiza jsudc (JavaScript ekosistem)

### 3.1 jsudc-core (`@jsudc/core`)

**Šta je:** Čist TypeScript UDC protokol — sve što prelazi žicu (envelope, filter DSL, schema, view, action payloads) kao Zod šeme + inferred tipovi.

**Uloga:**
- Definiše Protocol (ne zavisi od React, Node API, ili frameworka)
- Radi u browseru, Node, React Native, Angular
- Jedina runtime zavisnost: `zod`
- Dva entry point-a:
  - `@jsudc/core` — protocol + helpers
  - `@jsudc/core/client` — `UdcClient` (envelope RPC preko `fetch`)

**Struktura:**
```
src/
├── envelope.ts       # { kind, id, payload } — RPC okvir
├── filter.ts         # Filter DSL (between, operators)
├── schema.ts         # Zod схеме (field types, validation)
├── view.ts           # View config (columns, renderers, edit mode)
├── actions.ts        # describe, list, read, mutate, edit (schema revisions)
├── client.ts         # UdcClient + fetch transport
├── order.ts          # Sortiranje
├── query.ts          # Pagination (cursor-based)
├── row.ts            # Row data + validation
├── calendar.ts       # Calendar renderer
├── chart.ts          # Chart renderer
├── kanban.ts         # Kanban board renderer
├── menu.ts           # Menu/select renderer
├── tree.ts           # Tree renderer
├── map.ts            # Map renderer
└── validate.ts       # Helper za client-side validaciju
```

**Key design:**
- Nema `fetch` zavisnosti — klijent ga prosleđuje
- Nema React zavisnosti — može biti korišćen drugde
- All-in-one protocol file — server i client vuku iste šeme

### 3.2 jsudc-server (`@jsudc/server`)

**Šta je:** UDC server u TypeScript — čita kolekcije (YAML config), servira ih preko UDC protokola.

**Uloga:**
- Dispatcher — validira svaki request protiv `@jsudc/core` šema
- Collection registry — čita `view.yaml`, `schema.json`, `source.yaml`
- **Five sources:**
  - PostgreSQL (jsonb)
  - Memory (u-memory keš)
  - Filesystem (fajlovi)
  - HTTP API (proxy na drugi servis)
  - YAML menu (hardcoded lookup tablice)
- **Schema store** — revizije sa Postgres-a (za live schema edits)
- **Fastify plugin** — montira se na tvoj Fastify app
- Vraća OpenAPI dokument za svaku akciju (`/docs`)

**Struktura:**
```
src/
├── dispatcher.ts      # RPC dispatcher (request → action → response)
├── registry.ts        # Collection loader
├── sources/           # Source implementacije
│   ├── postgres.ts
│   ├── memory.ts
│   ├── filesystem.ts
│   ├── http.ts
│   └── yaml.ts
├── schema-store.ts    # Schema revisions (Postgres)
├── seed.ts            # Seeding iz schema.json
├── plugin.ts          # Fastify integration
└── migrations/        # Database migrations (schema_revisions tabla)
```

**Korišćenje:**
```typescript
import { connect, createDispatcher, loadRegistry, makeSource, udcPlugin } from "@jsudc/server";

// 1. Connect DB
const { db } = connect(DATABASE_URL);
await ensureUdcSchema(db);

// 2. Load collections
const registry = loadRegistry("./collections", (asset, reg) =>
  makeSource(asset, { db, registry: reg, env: process.env }),
);

// 3. Mount plugin
const fastify = Fastify();
await fastify.register(udcPlugin({ registry }));
```

**Collection definition:**
```
collections/
└── events/
    ├── view.yaml        # Columns, edit mode, renderers
    ├── schema.json      # Zod schema
    └── source.yaml      # Source type + config
```

### 3.3 jsudc-react

**Šta je:** React komponente za UDC — consumer strana.

**Komponente:**
- `UdcClient` — HTTP transport
- `UdcProvider` — context wrapper
- `UdcDataView` — tabela sa filterom, sort-om, paginacijom
- `UdcI18nProvider` — i18n lokalizacija
- Filter DSL helpers — client-side filter building

---

## 4. Poređenje: memento-spp (Python) vs jsmemento (JavaScript)

### 4.1 Što ćemo prepisati, što ćemo drugačije

| Aspekt | memento-spp (Python) | jsmemento (JS) — Plan |
|--------|----------------------|----------------------|
| **Runtime** | Python 3.14+ | Node.js 24+, možda Deno |
| **Web framework** | FastAPI + Uvicorn | Fastify + TypeScript |
| **ORM** | Tortoise ORM | Drizzle ORM (bolji za TS) ili Prisma |
| **Baza** | PostgreSQL (isto) | PostgreSQL (isto) |
| **Keš / Broker** | Redis (isto) | Redis (isto) |
| **Template engine** | Jinja2 | Nunjucks ili Handlebars (JS ekvivalent) |
| **Validacija** | Pydantic | Zod (poput jsudc) |
| **CLI** | Typer + Rich | Commander.js ili Yargs |
| **Lookup management** | dc-lookups (Python) | vlastiti Lookup sistem ili port |
| **Package org** | `memento` (pip) | `@memento/core`, `@memento/server`, `@memento/react` (npm) |
| **UDC integracija** | `udc-py` | `@jsudc/core` + `@jsudc/server` |
| **Deployment** | podman-compose | isti (Podman radi sa Node.js slikama) |
| **Testing** | pytest + asyncio | Vitest (kao jsudc) |

### 4.2 Vodič — šta kopiramo 1:1

**Kopiraj direktno:**
1. **Koncept entiteta** — `instance_type` + `instance_id` (opšti, ne zavisi od jezika)
2. **Multitenancy arhitektura** — tenant kontekst kroz middleware, stroga izolacija
3. **API key auth** — hashovanje, scope-ovi, tenant binding
4. **WebSocket design** — pub/sub Hub, slow-consumer detection
5. **Imutabilnost** — soft delete (arhiviranje), nikad brisanje
6. **Interakcije** — seen / unseen, star (bookmark) tracking
7. **Template rendering** — per-tenant overrides, locale fallback chain
8. **UDC integracija** — memento kao data source
9. **Baza šema** — `memento_` prefiks, isolation kontekst
10. **Lifecycle eventi** — push → persist → broadcast → render
11. **Admin operacije** — cross-tenant transfer

**Prilagodi za JS:**
1. **Paket struktura** — modularni npm paketi (jsudc model)
2. **Validacija** — Zod umesto Pydantic
3. **Template engine** — Nunjucks/Handlebars umesto Jinja2
4. **CLI** — Commander.js umesto Typer
5. **Tipizacija** — TypeScript (TS-first, ne Python-first)

---

## 5. Predložena arhitektura jsmemento

### 5.1 Paket struktura

```
jsmemento/                          (monorepo root)
├── packages/
│   ├── @memento/core/              # Protokol (Zod šeme, envelope, auth, helpers)
│   ├── @memento/server/            # Fastify server + dispatcher
│   ├── @memento/react/             # React komponente (DataView, provider)
│   ├── @memento/cli/               # CLI (tenant, key, template management)
│   └── @memento/client/            # JS client SDK (HTTP + WebSocket)
├── apps/
│   ├── example/                    # Example app (Fastify + React)
│   └── demo/                       # Interactive demo (poput Python verzije)
├── docs/                           # Architecture specs, deployment guides
├── .github/
│   └── workflows/                  # CI/CD (test, lint, publish)
├── pnpm-workspace.yaml
└── turbo.json                      # Build orchestration
```

### 5.2 Svaki paket — uloga i zavisnosti

| Paket | Uloga | Zavisnosti |
|-------|-------|-----------|
| `@memento/core` | Protocol + auth helpers | `zod` samo |
| `@memento/server` | Server dispatcher + plugin | `@memento/core`, `fastify`, `drizzle-orm`, `pg`, `zod` |
| `@memento/react` | UI komponente | `@memento/core`, `react`, `@tanstack/react-query` |
| `@memento/cli` | CLI komande | `@memento/core`, `commander`, `chalk` |
| `@memento/client` | Client SDK | `@memento/core` samo |

### 5.3 Tri deployment moda

```
┌─────────────────────────────────────────────────────────────┐
│                    jsmemento Deployments                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 1. EMBEDDED (npm paket)                                      │
│    ┌──────────────────────────┐                             │
│    │ Vaša Fastify aplikacija   │                            │
│    │ ├── @memento/server       │ ← npm install              │
│    │ └── UdcSource(memento)    │                            │
│    └──────────────────────────┘                             │
│                                                              │
│ 2. STANDALONE CONTAINER                                     │
│    ┌──────────────────────────┐                             │
│    │ Podman / Docker          │                             │
│    │ ├── memento-server image │                             │
│    │ ├── PostgreSQL (linked)  │                             │
│    │ └── Redis (linked)       │                             │
│    └──────────────────────────┘                             │
│    $ podman-compose up                                       │
│                                                              │
│ 3. MULTITENANT CLOUD SERVICE                                │
│    ┌──────────────────────────┐                             │
│    │ memento.example.com      │                             │
│    │ ├── API sa API ključima  │                             │
│    │ ├── SaaS frontend        │                             │
│    │ ├── PostgreSQL (managed) │                             │
│    │ └── Redis (managed)      │                             │
│    └──────────────────────────┘                             │
│    Klijent ne drži podatke — koristi samo API               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.4 Životni ciklus eventa (jsmemento)

```
1. POST /api/events (ili client.pushEvent())
   ↓ (ApiKeyAuth middleware)
2. Validacija (Zod + Lookups)
   ↓
3. Persist u PostgreSQL (memento_event)
   ↓
4. WebSocket pub/sub (Redis Streams ili në-Redi) — push na aktivne klijente
   ↓
5. Template render (Nunjucks + i18n fallback)
   ↓
6. GET /api/events, GET /api/entities/.../events, /udc/list
   (vrati rendered tekst)
   ↓
7. React <MementoDataView> automatski osvežava tabelu (bez polling-a)
```

---

## 6. Ekvivalencija ključnih kompoenata

| Memento (Python) | jsmemento (JS) | Fajl |
|------------------|-------------------|------|
| `fastapi.FastAPI` | `fastify.Fastify` | `@memento/server/src/index.ts` |
| `Pydantic` BaseModel | `Zod` schema | `@memento/core/src/schema.ts` |
| `Jinja2` Template | Nunjucks Template | `@memento/core/src/render.ts` |
| `ContextVar` (tenant) | `request.context` + middleware | `@memento/server/src/middleware.ts` |
| `asyncpg` driver | `pg` driver | (isti) |
| UdcSource | UdcSource implementacija | `@memento/server/src/udc-source.ts` |
| Typer CLI | Commander.js CLI | `@memento/cli/src/index.ts` |
| React SPA | React SPA (isti) | `@memento/react/src/` |
| pytest | Vitest | `packages/*/test/` |

---

## 7. Deployment: Primeri

### 7.1 Embedded (npm paket)

```typescript
// your-app/src/index.ts
import Fastify from "fastify";
import { mementoPlugin } from "@memento/server";

const fastify = Fastify();

await fastify.register(mementoPlugin, {
  database: process.env.DATABASE_URL,
  redis: process.env.REDIS_URL,
});

// `POST /memento/events`, `GET /memento/events`, `GET /memento/entities/:type/:id/events`
// i WebSocket na `/memento/ws`

await fastify.listen({ port: 3000 });
```

### 7.2 Standalone container

```yaml
# compose.yaml
services:
  memento:
    image: ghcr.io/digital-cube/memento:latest
    ports: ["8000:3000"]
    environment:
      DATABASE_URL: postgresql://...
      REDIS_URL: redis://...
      MEMENTO_API_BASE: https://example.com
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: memento
      POSTGRES_PASSWORD: secret
    volumes:
      - memento-data:/var/lib/postgresql/data

  redis:
    image: redis:7
```

### 7.3 Cloud SaaS

```bash
# User-facing — registruje se na memento.example.com
POST https://memento.example.com/api/auth/register
{
  "email": "acme@example.com",
  "password": "...",
  "company_name": "Acme Corp"
}
# → tenant je kreiram automatski
# → ispisuje API ključ

# Client-side — koristi cloud servis
const client = new MementoClient({
  baseUrl: "https://memento.example.com",
  apiKey: "mk_...",
});

await client.pushEvent({
  event_type: "USER_LOGIN",
  instance_type: "user",
  instance_id: "42",
});
```

---

## 8. Ključne odluke za jsmemento

1. **ORM:** Drizzle (tipizacija, Query builder) vs Prisma (DX) vs TypeORM (feature-rich)
   - **Preporuka:** Drizzle (koristi se u jsudc-server, mali footprint)

2. **Template engine:** Nunjucks (Jinja2-like) vs Handlebars (minimalan) vs ETA (lightweight)
   - **Preporuka:** Nunjucks (sintaksa sličnija Jinja2, nije drastična promena)

3. **CLI framework:** Commander.js vs Yargs vs Oclif
   - **Preporuka:** Commander.js (jednostavan, popularan, koristi se drugde)

4. **WebSocket:** `ws` paket vs Fastify `@fastify/websocket` vs SocketIO
   - **Preporuka:** Fastify `@fastify/websocket` (native integration, manji overhead)

5. **Pub/Sub:** Redis Streams vs Redis Pub/Sub vs RabbitMQ
   - **Preporuka:** Redis Pub/Sub (jednostavna, dovoljno za real-time, memento-spp koristi Redis)

6. **Lookup management:** Port dc-lookups-py vs vlastiti sistem
   - **Preporuka:** Vlastiti `@memento/lookups` paket sa YAML + CSV (jednostavnije bez Python zavisnosti)

7. **Package registry:** npm (javno) vs GitHub Packages (privatno)
   - **Preporuka:** npm (open source, kako je jsudc)

8. **Monorepo tooling:** pnpm + Turbo vs Nx vs Yarn workspaces
   - **Preporuka:** pnpm + Turbo (lake, kao jsudc. org)

---

## 9. Roadmap jsmemento

| Faza | Sadržaj | Procena |
|------|---------|--------|
| **Phase 1** | Core struktura, `@memento/core`, baza šema, Zod validacija | 2-3 nedelje |
| **Phase 2** | `@memento/server`, FastAPI-like routes, multitenancy middleware | 2-3 nedelje |
| **Phase 3** | WebSocket `/ws`, pub/sub, slow-consumer detection | 1-2 nedelje |
| **Phase 4** | Template rendering (Nunjucks), i18n fallback | 1 nedelja |
| **Phase 5** | `@memento/react` komponente (DataView, filters) | 1-2 nedelje |
| **Phase 6** | `@memento/cli` — tenant/key/template management | 1 nedelja |
| **Phase 7** | Docker image, podman-compose, CI/CD | 1 nedelja |
| **Phase 8** | Testovi (> 80% coverage), integracione test | 2 nedelje |
| **MVP release** | v1.0.0 na npm + GitHub | *Ukupno: 3-4 meseca* |

---

## 10. Sljedeći koraci

1. ✅ **Analiza** (ovaj dokument)
2. 📋 **Non-AI question ticket** — pitanja o:
   - ORM izboru, template engine-u, CLI framework-u
   - Lookup management strategiji
   - Deploy modu prioriteta (embedded vs container vs cloud)
   - Scope v1.0 MVP-a
3. 📐 **Architecture specification** — detaljne šeme, schema.sql, Zod type definitions
4. 🏗️ **Scaffolding** — repostruktura, pnpm workspace setup, turbo config
5. 💻 **Implementacija** — po fazama

---

## Prilog A: Fajlovi memorije

- `BRIEF.md` — project brief
- `TEHNOLOGIJE.md` — technology stack + principles
- README.md — setup instructions
- MEMENTO_STACK.md — detailed stack + bootstrap checklist

## Prilog B: Izvori

- **memento-spp repo:** `/tmp/memento-spp`
- **jsudc-core repo:** `/tmp/jsudc-core`
- **jsudc-server repo:** `/tmp/jsudc-server`

---

*Verzija dokumenta: 2026-10-30*
*Analiza obavljena tokom brainstorm sesije EPCXWNE2 (Root worktree)*
