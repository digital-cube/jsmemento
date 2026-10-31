import { ok } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import type { DemoKey } from "../demo.js";
import { MementoError } from "../errors.js";

export interface DemoRoutesOptions {
  /** Already checked by `resolveDemoKey`; `null` → the route answers 404. */
  demo: DemoKey | null;
}

/**
 * `GET /api/demo` — no API key needed: the read-only demo key the examples site connects
 * with, so a visitor never has to paste one. 404 when the deployment has none.
 */
export const demoRoutes: FastifyPluginAsync<DemoRoutesOptions> = async (app, { demo }) => {
  app.get("/api/demo", async (_request, reply) => {
    if (!demo) throw new MementoError("not_found", "this server has no demo key");
    reply.header("cache-control", "no-store");
    return ok({ api_key: demo.apiKey, tenant: demo.tenant });
  });
};
