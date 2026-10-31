import { LocaleSchema, type StreamFilter, StreamFilterSchema } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import { MementoError } from "../errors.js";
import type { StreamHub } from "../stream/hub.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `/ws` route's preValidation from the query string. */
    stream?: { filter: StreamFilter; locale?: string };
  }
}

/**
 * `GET /ws` — the real-time stream (WebSocket). Auth and the query string are checked
 * before the upgrade, so a bad key is a plain `401` and a bad filter a `422`.
 */
export const streamRoutes: FastifyPluginAsync<{ hub: StreamHub }> = async (app, { hub }) => {
  app.decorateRequest("stream", undefined);

  app.route({
    method: "GET",
    url: "/ws",
    config: { scope: "read" },
    preValidation: async (request) => {
      const { locale, ...filter } = (request.query ?? {}) as Record<string, unknown>;
      const parsedFilter = StreamFilterSchema.safeParse(filter);
      if (!parsedFilter.success) {
        throw new MementoError(
          "validation_error",
          "invalid stream filter",
          parsedFilter.error.issues,
        );
      }
      const parsedLocale = LocaleSchema.optional().safeParse(locale);
      if (!parsedLocale.success) {
        throw new MementoError("validation_error", "invalid locale", parsedLocale.error.issues);
      }
      request.stream = {
        filter: parsedFilter.data,
        ...(parsedLocale.data ? { locale: parsedLocale.data } : {}),
      };
    },
    handler: async () => {
      throw new MementoError("bad_request", "/ws is a WebSocket endpoint: send an Upgrade request");
    },
    wsHandler: async (socket, request) => {
      const tenant = request.tenant;
      const stream = request.stream;
      /* v8 ignore next 4 -- the route's scope and preValidation always set both */
      if (!tenant || !stream) {
        socket.close(1011, "not authenticated");
        return;
      }
      await hub.add(socket, { tenant, ...stream });
    },
  });
};
