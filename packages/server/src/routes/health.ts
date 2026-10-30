import { ok } from "@memento/core";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { RouteDeps } from "../app.js";

/** `GET /health` — liveness + database reachability. No API key needed. */
export const healthRoutes: FastifyPluginAsync<RouteDeps> = async (app, { db }) => {
  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return ok({ status: "ok" });
  });
};
