import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, runMigrations } from "./db/client.js";
import { emptyLookups, initLookups, type Lookups } from "./lookups.js";
import { type EventPublisher, NoopPublisher, RedisPublisher } from "./publisher.js";

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
const publisher: EventPublisher = config.redisUrl
  ? new RedisPublisher(config.redisUrl, config.redisChannelPrefix)
  : new NoopPublisher();

const app = await buildApp({
  db: database.db,
  publisher,
  prefix: config.apiPrefix,
  logger: { level: config.logLevel },
  lookups,
  defaultLocale: config.defaultLocale,
});
app.log.info(
  { path: config.lookups.path, sections: lookups.registry.sectionNames(), strict: lookups.strict },
  "lookups loaded",
);
for (const warning of lookupWarnings) app.log.warn(warning);

app.addHook("onClose", async () => {
  await publisher.close();
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
