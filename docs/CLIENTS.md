# Client programs (`clients/`)

`clients/<lang>/` holds one complete, runnable program per language — JavaScript, TypeScript,
Python, PHP, Java, Rust, Go and C++ — that uses the public API the way any integration would:
plain HTTP with `Authorization: Bearer <key>` and, for the live stream, a WebSocket with the
subprotocols `memento.v1` and `bearer.<key>`. No SDK: `@memento/core` stays unpublished, and the
programs use the language's ordinary HTTP client (`fetch`, `urllib`, `curl`, `HttpClient`,
`ureq`, `net/http`, `libcurl`).

The service site serves them on its `/clients` page (below): a person downloads one, sets
`MEMENTO_API_KEY` (and optionally `MEMENTO_URL`) and runs it. The site reads `clients/` when it
is built; nothing is copied into the app by hand.

## What each program does

The same three steps, in the same order, with the same event, so the programs read side by
side:

1. **Push** — `POST /events` with
   `{event_type: "USER_LOGIN", instance_type: "user", instance_id: <OS user>, actor_id: <OS user>, payload: {ip: "127.0.0.1", client: "<language>"}}`;
   prints `Pushed <id>` and the rendered line.
2. **Query** — `POST /events/query` with
   `{filter: {and: [{field: "instance_type", op: "eq", value: "user"}, {field: "instance_id", op: "eq", value: <OS user>}]}, limit: 10}`;
   prints `occurred_at  event_type  rendered` for each event, newest first (`data` is the array).
3. **Tail** — `GET /ws?instance_type=user&instance_id=<OS user>&locale=en` for 10 seconds;
   prints `Tailing user/<you> for 10 s …` on `memento.welcome`, the `rendered` line of every
   `memento.event.new` frame, ignores any other frame, then `Done.`. JavaScript, TypeScript,
   Python (with the `websockets` package), Java, Rust and Go have it; PHP and C++ print one line
   saying tail is not in this sample.

```
Pushed 3d5dd688-e169-4294-a0d5-c3b4e5b9aba8
  User igor logged in from 127.0.0.1.

Latest events of user/igor:
  2026-11-01T09:07:58.996Z  USER_LOGIN  User igor logged in from 127.0.0.1.

Tailing user/igor for 10 s …
  User igor logged in from 127.0.0.2.
Done.
```

Environment: `MEMENTO_API_KEY` (required, `read` + `write`) and `MEMENTO_URL` (default
`https://service.stage.memento-service.org/memento`). Exit codes: `2` without a key (with a
hint where to create one), `1` on any HTTP error (the status and the server's `error.message`,
e.g. `HTTP 401: invalid or expired API key` or `HTTP 429: …` once the key's daily limit is
used up), `0` otherwise.

The table of languages, files and run commands is in [`clients/README.md`](../clients/README.md);
each directory has its own README (install, the two variables, run).

## The `/clients` page of the service site

`apps/service` shows the programs at `/clients/<lang>` — public, logged in or not (the sidebar
has it for a signed-in user, the header for a visitor). One tab per language (JavaScript,
TypeScript, Python, PHP, Java, Rust, Go, C++); the choice is the URL and is remembered in
localStorage (`memento.service.clients.lang`), so a bare `/clients` opens the language seen last.
Per language:

- **Environment** — `MEMENTO_URL=<this origin>/memento` and `MEMENTO_API_KEY=mk_…` with a Copy
  button that copies exactly those two lines. The hint links to `/keys` when signed in, to
  `/register` otherwise. **No key is ever on the page or in a download** — the plaintext exists
  once, in the response that created it.
- The README's **Install**, **Set the two variables** and **Run** sections, as text.
- The **source** — the main file, plus the manifest (`package.json`, `Cargo.toml`, `go.mod`,
  `CMakeLists.txt`) as a second tab — with line numbers and Copy, highlighted by shiki at build
  time (the browser ships HTML, no grammars).
- **Download `<lang>.zip`** and the list of what is in it.

### Built from `clients/`: `apps/service/vite-plugin-clients.ts`

At `vite build` (and in `vite dev`) the plugin reads `clients/<lang>/` from the repository root:

- `virtual:clients` — per language `{id, label, run, readme: {install, variables, run},
  files: [{name, source, html}], zip}`. The README is split at its `## Install`,
  `## Set the two variables` and `## Run` headings; the run line is the first line of the Run
  section's code block. The page is its own chunk (`React.lazy`), so the other pages do not
  carry the sources.
- `dist/clients/<lang>.zip` — the directory under `<lang>/`, without `node_modules`, `target`,
  `build` and the names the directory's own `.gitignore` lists (the Go binary). Fixed entry
  times: the same `clients/` gives the same bytes. In dev the zip is answered at
  `/clients/<lang>.zip` and the page reloads when a file of `clients/` changes.

A missing `clients/`, README section, run line or shown file fails the build with the path in
the message. The order, labels and shown files are the plugin's `CLIENT_LANGUAGES`; a ninth
language is a directory plus one line there. `apps/service/turbo.json` adds `clients/**` to the
build's inputs, so a change of a program rebuilds the site. The image copies
`apps/service/dist` whole, zips included; `@memento/server` serves them as static files.

Tests: `apps/service/test/clients-plugin.test.ts` (README parsing and every zip's file list,
against the real `clients/`) and `clients-page.test.tsx` (tabs, URL and localStorage, the
environment block, Go's files and zip link).

## CI

`.github/workflows/clients.yml` runs a matrix job per language: PostgreSQL as a service, the
built server and CLI, `clients/check.sh stack` (starts the server on port 8000, creates a tenant
and a `read,write` key with the CLI, exports `MEMENTO_URL=http://127.0.0.1:8000/memento` and the
key), the language's toolchain (Node 22, Python 3.12 + `websockets`, PHP 8.4, Temurin 21, Rust
stable, Go from `go.mod`, libcurl + CMake), then `clients/check.sh run <lang>`:

- without `MEMENTO_API_KEY` → exit code 2 and the hint;
- with a wrong key → exit code 1 and the 401 on one line;
- with the key → exit code 0, the query's first line is the pushed event's rendered line, and
  — for the languages with tail — tail printed the event `check.sh` pushed (`ip 127.0.0.2`)
  once the program said it was tailing. The tail step ends by itself after 10 s.

The same script works locally (see [`clients/README.md`](../clients/README.md#checks));
`CLIENT_CMD` runs the program another way, e.g. with a toolchain in a container.
