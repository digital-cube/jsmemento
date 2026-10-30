import { FilterSchema, ok } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { RouteDeps } from "../app.js";
import { MementoError } from "../errors.js";
import { listEvents, pushEvent } from "../services/events.js";

const QueryBodySchema = z.looseObject({ filter: FilterSchema.nullish() });

export const eventRoutes: FastifyPluginAsync<RouteDeps> = async (app, { db, publisher }) => {
  /** Push one event. */
  app.post("/events", { config: { scope: "write" } }, async (request, reply) => {
    const event = await pushEvent(db, request.body as never, {
      publisher,
      onPublishError: (error) =>
        request.log.warn({ err: error }, "event stored but publishing to Redis failed"),
    });
    request.log.info({ event_id: event.id, event_type: event.event_type }, "event stored");
    return reply.status(201).send(ok(event));
  });

  /** List events: query-string filters + cursor pagination. */
  app.get("/events", { config: { scope: "read" } }, async (request) => {
    const page = await listEvents(db, request.query as Record<string, string>);
    return ok(page.events, page.meta);
  });

  /** Same as GET, with a Filter DSL tree in the body (`{ filter, limit, cursor, ... }`). */
  app.post("/events/query", { config: { scope: "read" } }, async (request) => {
    const parsed = QueryBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new MementoError("validation_error", "invalid filter", parsed.error.issues);
    }
    const { filter, ...query } = parsed.data;
    const page = await listEvents(db, query, filter ?? null);
    return ok(page.events, page.meta);
  });
};
