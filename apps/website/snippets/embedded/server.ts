import { connect, LocalBus, mementoPlugin, runMigrations } from "@jsmemento/server";
import Fastify from "fastify";

// DATABASE_URL picks the database: file:<path> is one SQLite file, postgresql://… your
// PostgreSQL, where memento's tables live next to yours, all named memento_*.
const database = connect(process.env.DATABASE_URL ?? "file:data/app.db");
await runMigrations(database.db); // on SQLite this creates the file on the first start

// One process: it publishes the events it stores and streams them to /ws itself.
// More than one (PostgreSQL only): a RedisPublisher and a RedisFeed, so every process sees every event.
const bus = new LocalBus();

const app = Fastify({ logger: true });
app.get("/", async () => ({ hello: "your own routes stay yours" }));
await app.register(mementoPlugin, {
  prefix: "/memento",
  db: database.db,
  publisher: bus,
  stream: { feed: bus },
});
app.addHook("onClose", async () => {
  await bus.close();
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
await app.listen({ port: Number(process.env.PORT ?? 8000) });
