/*
 * Where the site lives and where the memento instances it links to live, read once from the
 * environment at build time. astro.config.mjs, the components and the content import these
 * instead of spelling a host, so one build command serves stage and production. The defaults
 * are production's:
 *
 *   SITE_URL     the site's own origin, Astro's `site` (default https://memento-service.org)
 *   EXAMPLE_URL  the examples site every "live example" link opens
 *                (default https://examples.memento-service.org)
 *   SERVICE_URL  the self-service site where a visitor registers and gets an API key
 *                (default https://service.memento-service.org)
 *
 * deploy/website/stage.sh passes stage's three (https://stage.memento-service.org,
 * https://examples.stage.memento-service.org, https://service.stage.memento-service.org).
 *
 * The client programs (clients/) and the snippets (snippets/) are files, not pages: they name
 * the production service, CLIENTS_SERVICE_URL, and the build swaps it for SERVICE_URL in every
 * `?raw` import of them (forService, the Vite plugin in astro.config.mjs), so a stage build shows
 * stage's service and a production build production's. scripts/check-hosts.mjs fails a build
 * for production that still names stage.
 */
const origin = (value, fallback) => (value || fallback).replace(/\/+$/, "");

export const SITE_URL = origin(process.env.SITE_URL, "https://memento-service.org");
export const EXAMPLE_URL = origin(process.env.EXAMPLE_URL, "https://examples.memento-service.org");
export const SERVICE_URL = origin(process.env.SERVICE_URL, "https://service.memento-service.org");

/**
 * The service the client programs and snippets name in their files (the server swaps it in the
 * zips: CLIENTS_SERVICE_URL of packages/server/src/client-zips.ts, the same value).
 */
export const CLIENTS_SERVICE_URL = "https://service.memento-service.org";

/** `text` with the service of clients/ and snippets/ replaced by this build's SERVICE_URL. */
export const forService = (text) =>
  SERVICE_URL === CLIENTS_SERVICE_URL ? text : text.replaceAll(CLIENTS_SERVICE_URL, SERVICE_URL);

/** The repository on GitHub: source links, commits (src/components/BuildLine.astro). */
export const REPO_URL = "https://github.com/digital-cube/jsmemento";
