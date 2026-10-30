import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connect, runMigrations } from "./db/client.js";
import { type EventPublisher, NoopPublisher, RedisPublisher } from "./publisher.js";

const config = loadConfig();
const database = connect(config.databaseUrl);
await runMigrations(database.db);
const publisher: EventPublisher = config.redisUrl
  ? new RedisPublisher(config.redisUrl, config.redisChannelPrefix)
  : new NoopPublisher();

const app = await buildApp({
  db: database.db,
  publisher,
  prefix: config.apiPrefix,
  logger: { level: config.logLevel },
});

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
