import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, runMigrations } from "./db/client.js";
import { emptyLookups, initLookups, type Lookups } from "./lookups.js";
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

const app = await buildApp({
  db: database.db,
  publisher,
  prefix: config.apiPrefix,
  logger: { level: config.logLevel },
  lookups,
  defaultLocale: config.defaultLocale,
  stream: {
    feed,
    heartbeatIntervalMs: config.stream.heartbeatIntervalMs,
    maxBufferedMessages: config.stream.maxBufferedMessages,
  },
  ...(config.uiDir ? { ui: { root: config.uiDir } } : {}),
});
app.log.info(
  { path: config.lookups.path, sections: lookups.registry.sectionNames(), strict: lookups.strict },
  "lookups loaded",
);
for (const warning of lookupWarnings) app.log.warn(warning);
if (config.uiDir) app.log.info({ root: config.uiDir }, "serving the web UI at / and /en/");

app.addHook("onClose", async () => {
  await publisher.close();
  await feed.close();
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
