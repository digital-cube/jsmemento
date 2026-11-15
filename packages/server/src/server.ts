import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import { type AccountsOptions, buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, runMigrations } from "./db/index.js";
import { DemoKeyError } from "./demo.js";
import { emptyLookups, initLookups, type Lookups } from "./lookups.js";
import { BrevoMailer } from "./mail/mailer.js";
import { type EventPublisher, RedisPublisher } from "./publisher.js";
import { type EventFeed, LocalBus, RedisFeed } from "./stream/feed.js";

const config = loadConfig();
const database = connect(config.databaseUrl);
await runMigrations(database.db);
const lookupWarnings: string[] = [];
let lookups: Lookups;
if (existsSync(config.lookups.path)) {
  const loaded = await initLookups({
    path: config.lookups.path,
    ...(config.lookups.translationsPath
      ? { translationsPath: config.lookups.translationsPath }
      : {}),
    candidatesDir: config.lookups.candidatesDir,
    strict: config.lookups.strict,
    onError: (error) => app.log.warn({ err: error }, "could not record a lookup candidate"),
  });
  lookups = loaded;
  lookupWarnings.push(...loaded.warnings.map((w) => w.message));
} else {
  lookups = emptyLookups();
  lookupWarnings.push(`${config.lookups.path} not found: lookups disabled`);
}
const menuWarnings: string[] = [];
const menu = existsSync(config.menuPath) ? config.menuPath : undefined;
if (!menu) menuWarnings.push(`${config.menuPath} not found: no menu UDC collection`);
// With Redis, every process publishes there and streams what any process stored; without
// it, one process streams its own events through an in-memory bus.
let publisher: EventPublisher;
let feed: EventFeed;
if (config.redisUrl) {
  publisher = new RedisPublisher(config.redisUrl, config.redisChannelPrefix);
  feed = new RedisFeed(config.redisUrl, {
    prefix: config.redisChannelPrefix,
    onError: (error, channel) => app.log.warn({ err: error, channel }, "redis feed error"),
  });
} else {
  const bus = new LocalBus();
  publisher = bus;
  feed = bus;
}

// Self-service accounts (MEMENTO_ACCOUNTS): Brevo when a key is set, otherwise mails are
// logged; rate limit and quota counters in Redis when there is one, so every process shares
// them.
let accounts: AccountsOptions | undefined;
let rateLimitRedis: Redis | null = null;
if (config.accounts) {
  const { brevoApiKey, mailFrom } = config.accounts;
  if (config.redisUrl) {
    rateLimitRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
    rateLimitRedis.on("error", (error) => app.log.warn({ err: error }, "accounts redis error"));
  }
  accounts = {
    serviceUrl: config.accounts.serviceUrl,
    sessionDays: config.accounts.sessionDays,
    limits: config.limits,
    rateLimit: { redis: rateLimitRedis },
    // Today's per-key event counters (memento:quota:<key>:<day>), shared by every process.
    redis: rateLimitRedis,
    ...(brevoApiKey && mailFrom
      ? {
          mailer: new BrevoMailer({
            apiKey: brevoApiKey,
            from: mailFrom,
            // `app` exists by the time a mail is sent.
            log: { info: (o, m) => app.log.info(o, m), error: (o, m) => app.log.error(o, m) },
          }),
        }
      : {}),
  };
}

const app = await buildApp({
  db: database.db,
  publisher,
  prefix: config.apiPrefix,
  logger: { level: config.logLevel },
  trustProxy: config.trustProxy,
  ...(accounts ? { accounts } : {}),
  lookups,
  defaultLocale: config.defaultLocale,
  stream: {
    feed,
    heartbeatIntervalMs: config.stream.heartbeatIntervalMs,
    maxBufferedMessages: config.stream.maxBufferedMessages,
  },
  ...(config.uiDir ? { ui: { root: config.uiDir } } : {}),
  ...(menu ? { menu } : {}),
  // Refuses to start (DemoKeyError) unless the key resolves and is read-only.
  ...(config.demoApiKey ? { demoApiKey: config.demoApiKey } : {}),
}).catch(async (error: unknown) => {
  if (!(error instanceof DemoKeyError)) throw error;
  console.error(`memento: ${error.message}`);
  await database.close();
  process.exit(1);
});
app.log.info(
  { path: config.lookups.path, sections: lookups.registry.sectionNames(), strict: lookups.strict },
  "lookups loaded",
);
for (const warning of [...lookupWarnings, ...menuWarnings]) app.log.warn(warning);
if (menu) app.log.info({ path: menu }, "serving the menu UDC collection");
if (config.demoApiKey) app.log.info("GET /api/demo hands out the read-only demo key");
if (config.accounts) {
  app.log.info(
    {
      service_url: config.accounts.serviceUrl,
      mail: config.accounts.brevoApiKey ? "brevo" : "log",
      rate_limit_store: rateLimitRedis ? "redis" : "memory",
      quota_store: rateLimitRedis ? "redis" : "usage table",
      default_daily_limit: config.limits.defaultDailyLimit,
    },
    "self-service accounts on: /auth/* and the session cookie",
  );
}
if (config.uiDir) app.log.info({ root: config.uiDir }, "serving the web UI at / and /en/");

app.addHook("onClose", async () => {
  await publisher.close();
  await feed.close();
  rateLimitRedis?.disconnect();
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
