import { buildDescribe, ok } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import type { RouteDeps } from "../app.js";
import { requireTenant } from "../context.js";

/** `GET /describe` — capabilities, JSON schemas, filter fields and the default view. */
export const describeRoutes: FastifyPluginAsync<RouteDeps> = async (app, { capabilities }) => {
  app.get("/describe", { config: { scope: "read" } }, async () => {
    const tenant = requireTenant();
    return ok(buildDescribe({ slug: tenant.tenantSlug, name: tenant.tenantName }, capabilities));
  });
};
