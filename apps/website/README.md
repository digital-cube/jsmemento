# @jsmemento/website

The website of memento: **<https://memento-service.org>** (`www.` redirects there; stage:
<https://stage.memento-service.org>).
Astro + Starlight, MDX content under `src/content/docs` (the sidebar follows the directory
tree, groups registered in `astro.config.mjs`), Pagefind search, dark and light themes from
memento's own tokens (`src/styles/theme.css`, the ones of the under-construction page). Private,
static, not part of the Docker image.

## Run and build

From the repository root (Node 24, pnpm from `packageManager`):

```sh
pnpm install
pnpm --filter @jsmemento/website gen         # the generated pages (below); dev, build and typecheck run it first
pnpm --filter @jsmemento/website dev         # http://localhost:4321
pnpm --filter @jsmemento/website build       # apps/website/dist; fails on a broken internal link
pnpm --filter @jsmemento/website preview     # serves dist/
pnpm --filter @jsmemento/website typecheck   # gen + astro check + check:snippets (also in the root `pnpm typecheck`)
pnpm --filter @jsmemento/website test        # test/*.test.mjs (node --test): src/build-info.mjs, offline
```

`.astro` and `.mdx` files are not linted by Biome (the root `biome.json` skips them); the rest
of `src/` is. The build needs no network: the one thing it asks the network for, the npm
registry ([Build info](#build-info-the-footer-line-and-on-npm)), it can do without, and
`SITE_NPM=off` does not ask it at all. The tests are offline (a fake fetch and a fixture).

## Where each section comes from

| section | pages | source |
|---|---|---|
| Get started | `src/content/docs/get-started/*.mdx` | hand-written; the code from `snippets/` and `clients/` (below) |
| Concepts | `src/content/docs/concepts/*.mdx` | hand-written from `docs/` (PHILOSOPHY, ARCHITECTURE, API, TEMPLATES, STREAMING, CHATS, DEPLOYMENT) and the code; the shown code from `snippets/wire`, `lookups.yaml`, `packages/server/templates`, `packages/server/drizzle` |
| Reference | `src/content/docs/reference/*.md` — **generated, not in git** | `scripts/gen-reference.mjs`: `docs/API.md`, the Filter DSL section of `docs/ARCHITECTURE.md`, `docs/STREAMING.md`, `docs/CHATS.md`, `docs/CLI.md`, the environment-variable table of `docs/DEPLOYMENT.md`, `docs/SQLITE.md` |
| Examples | `src/content/docs/examples/*.mdx` | hand-written from `apps/examples/README.md` and the pages' code (one page per `menu.yaml` example, plus the service site); `<ExampleShot>` shows `src/assets/examples/<page>-<theme>.webp` |
| Clients | `src/content/docs/clients/*.mdx` | `clients/README.md` and `clients/<lang>/README.md` rendered at build time (`<ClientReadme>`), the programs imported raw (`<ClientSource>`, the file list in `src/clients.ts`) |
| Packages | `src/content/docs/packages/index.mdx`, `changelog.md` — **the changelog generated, not in git** | `<PackageTable>` reads `packages/*/package.json` and asks npm when each was published ([Build info](#build-info-the-footer-line-and-on-npm)); `scripts/gen-changelog.mjs` turns `CHANGELOG.md` into the changelog page |

### `npm run gen`: the generated pages

`scripts/gen-reference.mjs` and `scripts/gen-changelog.mjs` (shared code in
`scripts/repo-markdown.mjs`) write the Reference section and Packages › Changelog from the
repository's markdown; `dev`, `build` and `typecheck` run them first, and the output is
git-ignored. A page's title is the file's H1 (or the section's heading), its description the
first sentence of the opening paragraph, and a note on top names the file and the commit it was
last changed in. Links between the docs become links between the pages (anchors included,
checked by the links validator); other repository links go to GitHub, and a link to a file that
does not exist fails `gen`. A doc that reads wrong as a public page is fixed in `docs/`, not in
the generator. The list of pages is `REFERENCE` in `scripts/repo-markdown.mjs`, in the order of
the sidebar in `astro.config.mjs`. No network.

**Clients cannot drift either:** the pages render `clients/` itself, and `check:snippets` fails
when a `clients/<lang>/` with a README has no `src/content/docs/clients/<lang>.mdx` (or a page
has no directory).

## Content: the code is files, the pictures are shots

The rule, from jsudc.dev: **code the site shows is a file of the repository imported `?raw`,
never pasted into a page**, and every screenshot is a real shot of the live examples site.

| home section (`src/components/home/`) | where its content comes from |
|---|---|
| `OneEvent.astro` — one event, every way to read it | `snippets/wire/push.json` and the answers to it: `push.out.json`, `entity.out.json`, `entity-sr.out.json`, `query.json` → `query.out.json`, `ws.out.txt` |
| `Examples.astro` — the examples, live | `src/assets/examples/<page>-<theme>.webp` (`npm run shots`); one line per page here, the routes of `menu.yaml` |
| `Api.astro` — the API | `snippets/wire/udc-list.json` → `udc-list.out.json`, `error.json` → `error.out.json`; the routes table follows `docs/API.md` |
| `QuickStarts.astro` — start where you are | `snippets/docker/<n>-<step>.sh` + `.out.txt`, `snippets/sqlite/<n>-<step>.sh` + `.out.txt`, `snippets/client/`, `../../clients/javascript/memento.mjs`, `snippets/embedded/server.ts`, `snippets/react/App.tsx` |
| `Packages.astro` — packages | `packages/*/package.json` (name, version) at build time, *on npm* from the registry (`src/build-info.mjs`, below); the image tags of `docs/DEPLOYMENT.md` and the release date of the newest tag; at the bottom the build line |

Get started (`src/content/docs/get-started/`) imports the same `snippets/docker`,
`snippets/sqlite`, `snippets/client` and `snippets/embedded` files. Every command there was run
as written (the Docker one in a scratch directory with its own `COMPOSE_PROJECT_NAME` and ports;
the SQLite steps and `snippets/embedded/` in an empty directory with a fresh database file and
`REDIS_URL` unset, the packages installed from `pnpm pack` tarballs until a release has SQLite,
the server's log lines with time, pid and host as `…`; the client against service.stage with a
key made there); a `*.out.txt` is what the step printed then.

### `npm run capture`: the recorded requests and answers

```sh
MEMENTO_API_KEY=mk_… pnpm --filter @jsmemento/website capture
```

`scripts/capture.mjs` opens `/ws` for `user/42`, pushes `snippets/wire/push.json`, records the
frames, reads the event back (entity history in en and sr, the Filter DSL query), pushes
`error.json` for a 422, and lists `cpu_load` from the examples instance with the demo key it hands
out. It writes the `*.out.json` / `ws.out.txt` files: indented, an object that fits in 72 columns
on one line, every UUID cut to its first eight characters. The key needs `read` and `write`
(create one at `{SERVICE_URL}/keys`); `MEMENTO_URL` (default `{SERVICE_URL}/memento`) and
`UDC_URL` (default `{EXAMPLE_URL}/memento`) point it elsewhere. Run it when an answer's shape
changes, then commit the files.

### `npm run shots`: the examples site's screenshots

```sh
pnpm --filter @jsmemento/website exec playwright install chromium   # once
pnpm --filter @jsmemento/website shots                               # or: shots -- chat tail
```

`scripts/shots.mjs` (Playwright + sharp) opens each of the eight example pages on `EXAMPLE_URL`
(`SHOTS_BASE` overrides it) at 1280×800, device scale 2, waits for its data, and writes
`src/assets/examples/<page>-light.webp`. Commit the webp files; the build only reads them.
The Examples pages show the same files through `<ExampleShot name="<page>">`. **Dark:** the
examples site follows `@jsudc/react`'s theme (`html.dark` from localStorage
`udc-theme`, which the script sets), but `@jsmemento/ui-shell` has no dark tokens yet, so the
script takes the light theme only and the home page shows it in both of its own themes. Add
`"dark"` to `THEMES` once the examples site has a dark theme; `Examples.astro` and `ExampleShot.astro` pick up
`<page>-dark.webp` by themselves.

### `npm run check:snippets` (part of `typecheck`)

`scripts/check-snippets.mjs` fails on a code fence in the home page or Get started (and on a
`ts`/`js` fence anywhere but the generated pages, which are `docs/` itself), on a client program
without its page, on a `snippets/wire` file that is not JSON or a request without its
recorded answer, and runs `tsc -p snippets`: `server.ts`, `tail.ts` and `App.tsx` compile
against the workspace's `@jsmemento/server`, `@jsmemento/core` and `@jsmemento/react`, from their
sources (`@jsmemento/source`), so a renamed option breaks the check, not the reader.

## Build variables

Read once at build time by `src/site.mjs`; components and content import them instead of
spelling a host. The defaults are production's:

| variable | | default |
|---|---|---|
| `SITE_URL` | the site's own origin (Astro's `site`: canonical links, sitemap) | `https://memento-service.org` |
| `EXAMPLE_URL` | the examples site every "live example" link opens | `https://examples.memento-service.org` |
| `SERVICE_URL` | the service site where a visitor gets an API key | `https://service.memento-service.org` |

`deploy/website/stage.sh` passes stage's three (`https://stage.memento-service.org`,
`https://examples.stage.memento-service.org`, `https://service.stage.memento-service.org`).
In frontmatter, which cannot import, the hero writes `{EXAMPLE_URL}` / `{SERVICE_URL}` as a
link; `src/components/Hero.astro` resolves them and `astro.config.mjs` keeps them out of
`starlight-links-validator`.

The client programs (`clients/`) and the snippets (`snippets/`) are files the pages import
`?raw`, so they cannot import `SERVICE_URL`: they name the production service
(`https://service.memento-service.org`) and a Vite plugin in `astro.config.mjs` swaps it for
`SERVICE_URL` (`forService` in `src/site.mjs`); recorded output (`*.out.*`, `output.txt`) stays
as recorded. After `astro build`, `scripts/check-hosts.mjs` fails the build when a page names a
`service.stage.` host while `SERVICE_URL` is not stage's.

## Build info: the footer line and "On npm"

`src/build-info.mjs` works out, once per build, what the footer shows
(`src/components/BuildLine.astro`: on the home page beside "MIT licence." at the bottom of
`home/Packages.astro`, on every other page under Starlight's footer through the `Footer`
override `DocsFooter.astro`) and what the Packages list and table add:

| shown | where it comes from |
|---|---|
| `v1.1.0` | the root `package.json` |
| `released 2026-11-17` | the commit date of the newest `v<x.y.z>` tag reachable from the built commit (`git describe`, then `git log -1 --format=%cI <tag>`); without git history or without a tag (a tarball, a shallow clone) the `## [x.y.z] - <date>` heading of `CHANGELOG.md` for that version, said so in the hover. Beside the image on the home page: the tag and its date, or "no release tag yet" and the changelog's date |
| `built 2026-11-16 17:01 UTC` | the clock of the build, UTC (`SOURCE_DATE_EPOCH` when set) |
| `38705b6` | `git rev-parse HEAD`, linked to the commit on GitHub; left out without git |
| *On npm* | `https://registry.npmjs.org/<name>`: `dist-tags.latest` and its `time`, asked once per package in parallel during the build, with npm's version beside the date when it differs from the repository's |

The registry never fails the build. A 404 shows *not on npm yet*; no answer (offline, a timeout,
an error) leaves that package's cell empty and logs one warning for the build, and when no package
got an answer the column is not shown. Dates are `<time datetime="…">` with the ISO time in the
attribute and UTC in the text.

| variable | | default |
|---|---|---|
| `SITE_NPM` | `off`: do not ask the registry; a `.json` path (relative to `apps/website`): a fixture `{ "<name>": <registry document> \| null }`, `null` being a 404, a missing name no answer | unset: the registry |
| `SITE_NPM_TIMEOUT_MS` | how long one registry request may take | `5000` |

```sh
SITE_NPM=off pnpm --filter @jsmemento/website build                              # offline, no warning
SITE_NPM=test/fixtures/npm-published.json pnpm --filter @jsmemento/website dev   # published dates, one package behind, one not on npm
```

CI's *Website build* job builds with `SITE_NPM=off`. Everything is read when the site is built,
so the dates are as fresh as the build: `deploy/website/stage.sh` rebuilds for a new commit or a
new release tag on it (or with `--force`; a package published to npm since shows after the next
rebuild), and a `turbo run build` served from the cache keeps the build time of the cached run.
`stage.sh` and `prod.sh` fetch the tags, so the release date comes from git.

## Deploy: stage

On the stage VM, from any copy of the repository:

```sh
deploy/website/stage.sh --install           # once: links the vhost into sites-enabled, reloads nginx, deploys
deploy/website/stage.sh                     # every deploy: builds origin/main and swaps it in
deploy/website/stage.sh --branch <name>     # a branch before review
```

Build-and-swap into `/home/digital/sites/stage.memento-service.org/releases/<short sha>`, the
`current` symlink nginx serves (`deploy/website/nginx/stage.memento-service.org.conf`), three
releases kept, checked through nginx and the edge. Details, and the old mementoservice vhost
that had the name: [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#the-website).

## Deploy: production

`https://memento-service.org` on `digitalcube-production-websites`, built from a **release
tag** (the newest by default), `www.memento-service.org` a 301 to it:

```sh
scp deploy/website/prod.sh digitalcube-production-websites:/tmp/ && \
  ssh digitalcube-production-websites /tmp/prod.sh --install          # once
~/sites/memento-service.org/ops/deploy/website/prod.sh                 # on the VM: every deploy
~/sites/memento-service.org/ops/deploy/website/prod.sh --ref v1.1.0    # a pinned build; a rollback is an older tag
```

The site is `src/` at the tag, the script and the vhost
(`deploy/website/nginx/memento-service.org.conf`) are `ops/` at `main`; the same
build-and-swap as stage. Details: [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#production-memento-serviceorg).
