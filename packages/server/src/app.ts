import { randomUUID } from "node:crypto";
import { type Capabilities, ERROR_CODES, type ErrorCode, fail } from "@memento/core";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
  LogController,
} from "fastify";
import { installAuth } from "./auth.js";
import type { Database } from "./db/client.js";
import { MementoError } from "./errors.js";
import { emptyLookups, type Lookups } from "./lookups.js";
import { type EventPublisher, NoopPublisher } from "./publisher.js";
import { chatRoutes } from "./routes/chats.js";
import { describeRoutes } from "./routes/describe.js";
import { entityRoutes } from "./routes/entities.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { EventRenderer } from "./templates/renderer.js";

export interface MementoPluginOptions {
  db: Database;
  publisher?: EventPublisher;
  /** Overrides what `/describe` advertises (e.g. `realtime: true` once a hub runs). */
  capabilities?: Partial<Capabilities>;
  /** Vocabulary (see `initLookups`). Default: none — nothing checked or recorded. */
  lookups?: Lookups;
  /** Locale events render in when a request names none. Default `en`. */
  defaultLocale?: string;
  /** Default: an `EventRenderer` over the bundled templates and the tenant overrides. */
  renderer?: EventRenderer;
}

export interface RouteDeps {
  db: Database;
  publisher: EventPublisher;
  capabilities: Partial<Capabilities>;
  lookups: Lookups;
  renderer: EventRenderer;
}

/** The error code of a framework error (bad JSON, wrong content type, …) by HTTP status. */
export function codeForStatus(status: number): ErrorCode {
  const match = Object.entries(ERROR_CODES).find(([, code]) => code === status);
  return match ? (match[0] as ErrorCode) : "bad_request";
}

const REQUEST_ID_RE = /^[\w.:-]{1,128}$/;

/** Accepts a sane incoming `X-Request-Id`, otherwise generates a UUID. */
export function requestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/**
 * The memento API as an encapsulated Fastify plugin. Register it with a `prefix`
 * (e.g. `/memento`) in your own app for the embedded deployment mode.
 */
export const mementoPlugin: FastifyPluginAsync<MementoPluginOptions> = async (app, options) => {
  const lookups = options.lookups ?? emptyLookups();
  const deps: RouteDeps = {
    db: options.db,
    publisher: options.publisher ?? new NoopPublisher(),
    capabilities: options.capabilities ?? {},
    lookups,
    renderer:
      options.renderer ??
      new EventRenderer({
        db: options.db,
        registry: lookups.registry,
        defaultLocale: options.defaultLocale ?? "en",
        onError: (error, template) =>
          app.log.warn({ err: error, template }, "template failed to render; using fallback"),
      }),
  };

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error: FastifyError | MementoError, request, reply) => {
    if (error instanceof MementoError) {
      if (error.status >= 500) request.log.error({ err: error }, error.message);
      else request.log.info({ code: error.code }, error.message);
      return reply
        .status(error.status)
        .send(fail(error.code, error.message, { details: error.details, request_id: request.id }));
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      request.log.info({ err: error }, error.message);
      return reply
        .status(status)
        .send(fail(codeForStatus(status), error.message, { request_id: request.id }));
    }
    request.log.error({ err: error }, "unhandled error");
    return reply
      .status(ERROR_CODES.internal_error)
      .send(fail("internal_error", "internal server error", { request_id: request.id }));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(ERROR_CODES.not_found).send(
      fail("not_found", `route ${request.method} ${request.url} not found`, {
        request_id: request.id,
      }),
    ),
  );

  installAuth(app, deps.db);
  await app.register(healthRoutes, deps);
  await app.register(eventRoutes, deps);
  await app.register(entityRoutes, deps);
  await app.register(chatRoutes, deps);
  await app.register(describeRoutes, deps);
};

export interface BuildAppOptions extends MementoPluginOptions {
  /** Mount point of the memento routes. Default `/memento`. */
  prefix?: string;
  /** pino options, `false` to silence, `true` for defaults. */
  logger?: FastifyServerOptions["logger"];
}

/** Standalone server: a Fastify instance with the memento plugin mounted. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: (request) => requestId(request.headers["x-request-id"]),
    logController: new LogController({ requestIdLogLabel: "request_id" }),
  });
  const { prefix, logger: _logger, ...plugin } = options;
  await app.register(mementoPlugin, { ...plugin, prefix: prefix ?? "/memento" });
  return app;
}
