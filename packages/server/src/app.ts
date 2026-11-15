import { randomUUID } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import type { CollectionRegistry } from "@jsudc/server";
import {
  type Capabilities,
  ERROR_CODES,
  type ErrorCode,
  fail,
  STREAM_SUBPROTOCOL,
} from "@memento/core";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
  LogController,
} from "fastify";
import type { Redis } from "ioredis";
import { installAuth } from "./auth.js";
import type { LimitsConfig } from "./config.js";
import type { Database } from "./db/index.js";
import { resolveDemoKey } from "./demo.js";
import { MementoError } from "./errors.js";
import { emptyLookups, type Lookups } from "./lookups.js";
import { AccountMails } from "./mail/account-mails.js";
import { LogMailer, type Mailer } from "./mail/mailer.js";
import { MailTemplates } from "./mail/templates.js";
import { type EventPublisher, NoopPublisher } from "./publisher.js";
import { QuotaGuard } from "./quota.js";
import { accountRoutes } from "./routes/accounts.js";
import { adminRoutes } from "./routes/admin.js";
import { chatRoutes } from "./routes/chats.js";
import { demoRoutes } from "./routes/demo.js";
import { describeRoutes } from "./routes/describe.js";
import { entityRoutes } from "./routes/entities.js";
import { eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { keyRoutes } from "./routes/keys.js";
import { streamRoutes } from "./routes/stream.js";
import type { EventFeed } from "./stream/feed.js";
import { StreamHub } from "./stream/hub.js";
import { EventRenderer } from "./templates/renderer.js";
import { eventCollections } from "./udc/collections.js";
import { menuCollection } from "./udc/menu.js";
import { udcRoutes } from "./udc/plugin.js";
import { MementoRegistry } from "./udc/registry.js";
import { type UiOptions, uiRoutes } from "./ui.js";
import { UsageMeter } from "./usage.js";

export interface StreamOptions {
  /** Where stored events come from: a `RedisFeed`, or the `LocalBus` that is also the publisher. */
  feed: EventFeed;
  /** Default 30 000. */
  heartbeatIntervalMs?: number;
  /** Unwritten messages per connection before it is dropped as a slow consumer. Default 1000. */
  maxBufferedMessages?: number;
}

/** Self-service accounts (`MEMENTO_ACCOUNTS`): the `/auth/*` routes and the session cookie. */
export interface AccountsOptions {
  /** Public origin of the service site: the links in the verify / reset mails. */
  serviceUrl: string;
  /** Sliding session lifetime. Default 30. */
  sessionDays?: number;
  /** Default: a `LogMailer` (mails logged at info level, not sent). */
  mailer?: Mailer;
  /** Default: the bundled `mail/` templates. */
  mailTemplates?: MailTemplates;
  /** Quota defaults `GET /auth/me` reports. Default 10 keys, 100 000 events/day, no ceiling. */
  limits?: LimitsConfig;
  /** Auth rate limits: `max` requests per `timeWindowMs` (default 10 per 15 min). */
  rateLimit?: { max?: number; timeWindowMs?: number; redis?: Redis | null };
  /**
   * Where today's per-key event counters live (`memento:quota:<key>:<day>`); `null`/absent →
   * summed from `memento_apikey_usage` and this process's unflushed counters.
   */
  redis?: Redis | null;
  /** Default: a `UsageMeter` over `memento_apikey_usage`, flushed every 5 s and on close. */
  usage?: UsageMeter;
  /** The clock of the daily limits (tests pin it). */
  now?: () => Date;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  defaultMaxKeys: 10,
  defaultDailyLimit: 100_000,
  maxDailyLimit: null,
};

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
  /** Enables the WebSocket stream `GET /ws` (and `realtime: true` in `/describe`). */
  stream?: StreamOptions;
  /**
   * The UDC collections served under `/udc/<action>` (`@jsudc/server`). Default: memento's
   * own (`events`, `cpu_load`, `activity`, see `eventCollections`); pass a registry to serve others,
   * `false` to serve none.
   */
  udc?: CollectionRegistry | false;
  /**
   * A menu YAML served as the `menu` UDC collection next to the others (`menuCollection`):
   * the examples site's sidebar. The file must exist. Default: no `menu` collection.
   */
  menu?: string;
  /**
   * A read-only API key `GET /api/demo` hands out (no auth), so the examples site connects
   * without the visitor pasting one. Checked while the plugin registers: an unknown, revoked
   * or not exactly `read`-scoped key fails startup (`DemoKeyError`). Default: none → 404.
   */
  demoApiKey?: string;
  /** Turns on self-service accounts. Default: off — no `/auth/*`, no session credential. */
  accounts?: AccountsOptions;
}

/** Selects `memento.v1` when offered, else the `bearer.<key>` protocol the client sent. */
export function selectSubprotocol(protocols: Set<string>): string | false {
  if (protocols.has(STREAM_SUBPROTOCOL)) return STREAM_SUBPROTOCOL;
  for (const protocol of protocols) if (protocol.startsWith("bearer.")) return protocol;
  return false;
}

export interface RouteDeps {
  db: Database;
  publisher: EventPublisher;
  capabilities: Partial<Capabilities>;
  lookups: Lookups;
  renderer: EventRenderer;
  /** Per-key usage counters (`MEMENTO_ACCOUNTS`); `null` → not metered. */
  usage: UsageMeter | null;
  /** Daily event limits of keys (`MEMENTO_ACCOUNTS`); `null` → unlimited. */
  quota: QuotaGuard | null;
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
  const accounts = options.accounts;
  const limits = accounts?.limits ?? DEFAULT_LIMITS;
  // Self-service mode meters every API key and holds it to its daily limit.
  const usage = accounts
    ? (accounts.usage ?? new UsageMeter({ db: options.db, log: app.log }))
    : null;
  const mailer = accounts ? (accounts.mailer ?? new LogMailer(app.log)) : null;
  const mailTemplates = accounts ? (accounts.mailTemplates ?? new MailTemplates()) : null;
  const serviceUrl = accounts?.serviceUrl.replace(/\/+$/, "") ?? "";
  const quota =
    accounts && usage && mailer && mailTemplates
      ? new QuotaGuard({
          db: options.db,
          usage,
          redis: accounts.redis ?? null,
          defaultDailyLimit: limits.defaultDailyLimit,
          mail: { mailer, templates: mailTemplates, serviceUrl },
          log: app.log,
          ...(accounts.now ? { now: accounts.now } : {}),
        })
      : null;
  const deps: RouteDeps = {
    usage,
    quota,
    db: options.db,
    publisher: options.publisher ?? new NoopPublisher(),
    capabilities: { ...(options.stream ? { realtime: true } : {}), ...options.capabilities },
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

  // Order matters: the hub's preClose must run before @fastify/websocket's (which closes
  // sockets without a code), and the plugin's onRequest before auth's (a refused upgrade
  // socket is only destroyed when the plugin saw the request first).
  let hub: StreamHub | null = null;
  if (options.stream) {
    const stream = options.stream;
    hub = new StreamHub({
      feed: stream.feed,
      log: app.log,
      renderer: deps.renderer,
      ...(stream.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: stream.heartbeatIntervalMs }
        : {}),
      ...(stream.maxBufferedMessages !== undefined
        ? { maxBufferedMessages: stream.maxBufferedMessages }
        : {}),
      usage,
    });
    const closing = hub;
    app.addHook("preClose", async () => closing.close());
    if (!app.hasDecorator("websocketServer")) {
      await app.register(fastifyWebsocket, {
        options: { maxPayload: 64 * 1024, handleProtocols: selectSubprotocol },
      });
    }
  }

  // After the hub's: its connections add their last stream seconds as they close.
  if (usage) app.addHook("preClose", async () => usage.close());
  const sessions = accounts ? { days: accounts.sessionDays ?? 30 } : null;
  if (accounts && !app.hasRequestDecorator("cookies")) await app.register(fastifyCookie);
  installAuth(app, deps.db, { sessions, usage });
  if (hub) await app.register(streamRoutes, { hub });
  await app.register(healthRoutes, deps);
  await app.register(eventRoutes, deps);
  await app.register(entityRoutes, deps);
  await app.register(chatRoutes, deps);
  await app.register(describeRoutes, deps);
  const demo = options.demoApiKey ? await resolveDemoKey(deps.db, options.demoApiKey) : null;
  await app.register(demoRoutes, { demo });
  if (accounts && sessions && mailer && mailTemplates && quota) {
    await app.register(accountRoutes, {
      db: deps.db,
      mails: new AccountMails({ mailer, templates: mailTemplates, serviceUrl, log: app.log }),
      sessionDays: sessions.days,
      limits,
      rateLimit: {
        max: accounts.rateLimit?.max ?? 10,
        timeWindowMs: accounts.rateLimit?.timeWindowMs ?? 15 * 60_000,
        redis: accounts.rateLimit?.redis ?? null,
      },
    });
    await app.register(keyRoutes, { ...deps, quota, limits });
    await app.register(adminRoutes, { ...deps, quota, limits });
  }
  if (options.udc !== false) {
    const registry =
      options.udc ??
      eventCollections({
        db: deps.db,
        renderer: deps.renderer,
        ...(quota ? { accounts: { quota } } : {}),
      });
    if (options.menu) {
      const menu = menuCollection({ file: options.menu, registry });
      // With accounts the menu is read by a signed-in user too: the service site has no key.
      if (sessions && registry instanceof MementoRegistry) {
        registry.register({ ...menu, auth: "key_or_session" });
      } else {
        registry.register(menu);
      }
    }
    await app.register(udcRoutes, { db: deps.db, registry, sessions, usage });
  }
};

export interface BuildAppOptions extends MementoPluginOptions {
  /** Mount point of the memento routes. Default `/memento`. */
  prefix?: string;
  /** pino options, `false` to silence, `true` for defaults. */
  logger?: FastifyServerOptions["logger"];
  /**
   * A built web UI (the examples site) served at `/` and `/en/` next to the API (`uiRoutes`).
   * Default: none — only the API answers.
   */
  ui?: Omit<UiOptions, "apiPrefix">;
  /** Fastify `trustProxy`: client IP / protocol from `X-Forwarded-*` (behind nginx). */
  trustProxy?: boolean;
}

/** Standalone server: a Fastify instance with the memento plugin mounted. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: (request) => requestId(request.headers["x-request-id"]),
    logController: new LogController({ requestIdLogLabel: "request_id" }),
    trustProxy: options.trustProxy ?? false,
  });
  const { prefix, logger: _logger, ui, trustProxy: _trustProxy, ...plugin } = options;
  await app.register(mementoPlugin, { ...plugin, prefix: prefix ?? "/memento" });
  if (ui) await app.register(uiRoutes, { ...ui, apiPrefix: prefix ?? "/memento" });
  return app;
}
