/**
 * What `virtual:clients` (apps/service/vite-plugin-clients.ts) exports: the programs of
 * `clients/<lang>/`, read when the site is built (and in dev), in the page's tab order.
 */

/**
 * The service the sources of `clients/<lang>/` name (default `MEMENTO_URL`, the keys page).
 * The page shows them with this site's origin instead (`localizePrograms`), as the server
 * serves their zips with its `MEMENTO_SERVICE_URL` — CLIENTS_SERVICE_URL of
 * packages/server/src/client-zips.ts, the same value (test/clients-plugin.test.ts checks).
 */
export const CLIENTS_SERVICE_URL = "https://service.memento-service.org";

/** One block of a README section: a paragraph (inline `code` and links kept) or a code fence. */
export type ReadmeBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string };

/** The three `##` sections every client README has. */
export interface ClientReadme {
  install: ReadmeBlock[];
  variables: ReadmeBlock[];
  run: ReadmeBlock[];
}

/** A file shown on the page: its path under `clients/<lang>/`, the text, the highlighted HTML. */
export interface ClientFile {
  name: string;
  source: string;
  /** Shiki's `<pre class="shiki">…</pre>`, rendered at build time; absent → plain monospace. */
  html?: string;
}

export interface ClientProgram {
  /** The directory name: `javascript`, `golang`, `cpp`, … — also the URL (`/clients/golang`). */
  id: string;
  /** The tab: `JavaScript`, `Go`, `C++`, … */
  label: string;
  /** The README's run command (`go run .`). */
  run: string;
  readme: ClientReadme;
  /** The main program first, then its manifest (`go.mod`, `Cargo.toml`, …) when it has one. */
  files: ClientFile[];
  /** Every path inside `<id>.zip`, `<id>/` first in each. */
  zip: string[];
}
