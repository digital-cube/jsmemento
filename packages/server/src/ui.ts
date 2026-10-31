import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { ERROR_CODES, fail } from "@memento/core";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

export interface UiOptions {
  /** A built single-page app (`vite build` output): a directory with `index.html`. */
  root: string;
  /**
   * Paths the app's `index.html` answers under, besides `/`. Default `["/en"]`. Assets are
   * served from `/` (Vite's default `base`), so each mount only needs the page itself.
   */
  mounts?: string[];
  /** The API prefix (e.g. `/memento`): unknown paths under it stay JSON 404s, never the page. */
  apiPrefix?: string;
}

/** `index.html` is revalidated on every load; hashed `assets/*` are cached for a year. */
function cacheHeaders(reply: FastifyReply, path: string): void {
  reply.header(
    "cache-control",
    /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
  );
}

/**
 * Serves a built React app (the CPU monitor) at `/` and every mount (default `/en/`), with an
 * `index.html` fallback for client-side routes. Register it at the root of the app, next to
 * the memento plugin; it never answers under `apiPrefix`.
 */
export const uiRoutes: FastifyPluginAsync<UiOptions> = async (app, options) => {
  if (!existsSync(join(options.root, "index.html"))) {
    throw new Error(`UI directory ${options.root} has no index.html`);
  }
  const apiPrefix = (options.apiPrefix ?? "/memento").replace(/\/+$/, "");
  const mounts = (options.mounts ?? ["/en"]).map((mount) => `/${mount.replace(/^\/+|\/+$/g, "")}`);

  await app.register(fastifyStatic, {
    root: options.root,
    prefix: "/",
    wildcard: false,
    index: ["index.html"],
    setHeaders: cacheHeaders,
  });

  const page = (reply: FastifyReply) => reply.sendFile("index.html");

  for (const mount of mounts) {
    app.get(mount, (_request, reply) => reply.redirect(`${mount}/`, 301));
    app.get(`${mount}/*`, (_request, reply) => page(reply));
  }

  // Client-side routes (and paths with no file) get the page; API paths and non-page
  // requests keep a plain 404.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const underApi = path === apiPrefix || path.startsWith(`${apiPrefix}/`);
    const wantsPage = (request.headers.accept ?? "").includes("text/html");
    if ((request.method === "GET" || request.method === "HEAD") && wantsPage && !underApi) {
      return page(reply);
    }
    return reply
      .status(ERROR_CODES.not_found)
      .send(fail("not_found", `route ${request.method} ${path} not found`));
  });
};
