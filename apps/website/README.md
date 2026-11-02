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
pnpm --filter @memento/website typecheck   # astro check (also part of the root `pnpm typecheck`)
```

`.astro` and `.mdx` files are not linted by Biome (the root `biome.json` skips them); the rest
of `src/` is. The build needs no network.

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
