import { ok } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import type { RouteDeps } from "../app.js";
import { entityHistory } from "../services/events.js";

/** `GET /entities/:instance_type/:instance_id/events` — one entity's history. */
export const entityRoutes: FastifyPluginAsync<RouteDeps> = async (app, { db, renderer }) => {
  app.get<{ Params: { instance_type: string; instance_id: string } }>(
    "/entities/:instance_type/:instance_id/events",
    { config: { scope: "read" } },
    async (request) => {
      const page = await entityHistory(
        db,
        request.params,
        request.query as Record<string, string>,
        { renderer },
      );
      return ok(page.events, page.meta);
    },
  );
};
