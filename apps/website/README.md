# @memento/website

The website of memento: **memento-service.org** (stage: <https://stage.memento-service.org>).
Astro + Starlight, MDX content under `src/content/docs` (the sidebar follows the directory
tree, groups registered in `astro.config.mjs`), Pagefind search, dark and light themes from
memento's own tokens (`src/styles/theme.css`, the ones of the under-construction page). Private,
static, not part of the Docker image.

## Run and build

From the repository root (Node 24, pnpm from `packageManager`):

```sh
pnpm install
pnpm --filter @memento/website dev         # http://localhost:4321
pnpm --filter @memento/website build       # apps/website/dist; fails on a broken internal link
pnpm --filter @memento/website preview     # serves dist/
pnpm --filter @memento/website typecheck   # astro check + check:snippets (also in the root `pnpm typecheck`)
```

`.astro` and `.mdx` files are not linted by Biome (the root `biome.json` skips them); the rest
of `src/` is. The build needs no network.

## Content: the code is files, the pictures are shots

The rule, from jsudc.dev: **code the site shows is a file of the repository imported `?raw`,
never pasted into a page**, and every screenshot is a real shot of the live examples site.

| home section (`src/components/home/`) | where its content comes from |
|---|---|
| `OneEvent.astro` — one event, every way to read it | `snippets/wire/push.json` and the answers to it: `push.out.json`, `entity.out.json`, `entity-sr.out.json`, `query.json` → `query.out.json`, `ws.out.txt` |
| `Examples.astro` — the examples, live | `src/assets/examples/<page>-<theme>.webp` (`npm run shots`); one line per page here, the routes of `menu.yaml` |
| `Api.astro` — the API | `snippets/wire/udc-list.json` → `udc-list.out.json`, `error.json` → `error.out.json`; the routes table follows `docs/API.md` |
| `QuickStarts.astro` — start where you are | `snippets/docker/<n>-<step>.sh` + `.out.txt`, `snippets/client/`, `../../clients/javascript/memento.mjs`, `snippets/embedded/server.ts`, `snippets/react/App.tsx` |
| `Packages.astro` — packages | `packages/*/package.json` (name, version) at build time; the image tags of `docs/DEPLOYMENT.md` |

Get started (`src/content/docs/get-started/`) imports the same `snippets/docker`,
`snippets/client` and `snippets/embedded` files. Every command there was run as written
(the Docker one in a scratch directory with its own `COMPOSE_PROJECT_NAME` and ports, the client
against service.stage with a key made there); a `*.out.txt` is what the step printed then.

### `npm run capture`: the recorded requests and answers

```sh
MEMENTO_API_KEY=mk_… pnpm --filter @memento/website capture
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
pnpm --filter @memento/website exec playwright install chromium   # once
pnpm --filter @memento/website shots                               # or: shots -- chat tail
```

`scripts/shots.mjs` (Playwright + sharp) opens each of the eight example pages on `EXAMPLE_URL`
(`SHOTS_BASE` overrides it) at 1280×800, device scale 2, waits for its data, and writes
`src/assets/examples/<page>-light.webp`. Commit the webp files; the build only reads them.
**Dark:** the examples site follows `@jsudc/react`'s theme (`html.dark` from localStorage
`udc-theme`, which the script sets), but `@memento/ui-shell` has no dark tokens yet, so the
script takes the light theme only and the home page shows it in both of its own themes. Add
`"dark"` to `THEMES` once the examples site has a dark theme; `Examples.astro` picks up
`<page>-dark.webp` by itself.

### `npm run check:snippets` (part of `typecheck`)

`scripts/check-snippets.mjs` fails on a code fence in the home page or Get started (and on a
`ts`/`js` fence anywhere), on a `snippets/wire` file that is not JSON or a request without its
recorded answer, and runs `tsc -p snippets`: `server.ts`, `tail.ts` and `App.tsx` compile
against the workspace's `@memento/server`, `@memento/core` and `@memento/react`, from their
sources (`@memento/source`), so a renamed option breaks the check, not the reader.

## Build variables

Read once at build time by `src/site.mjs`; components and content import them instead of
spelling a host. The defaults are production's:

| variable | | default |
|---|---|---|
| `SITE_URL` | the site's own origin (Astro's `site`: canonical links, sitemap) | `https://memento-service.org` |
| `EXAMPLE_URL` | the examples site every "live example" link opens | `https://examples.stage.memento-service.org` |
| `SERVICE_URL` | the service site where a visitor gets an API key | `https://service.stage.memento-service.org` |

No production examples or service instance exists yet; those two defaults move when one does.
In frontmatter, which cannot import, the hero writes `{EXAMPLE_URL}` / `{SERVICE_URL}` as a
link; `src/components/Hero.astro` resolves them and `astro.config.mjs` keeps them out of
`starlight-links-validator`.

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
