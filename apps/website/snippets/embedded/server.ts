import { connect, LocalBus, mementoPlugin, runMigrations } from "@memento/server";
import Fastify from "fastify";

// Your database; memento's tables live next to yours, all named memento_*.
const { db } = connect(process.env.DATABASE_URL ?? "postgresql://localhost:5432/app");
await runMigrations(db);

// One process: it publishes the events it stores and streams them to /ws itself.
// More than one: a RedisPublisher and a RedisFeed instead, so every process sees every event.
const bus = new LocalBus();

const app = Fastify({ logger: true });
app.get("/", async () => ({ hello: "your own routes stay yours" }));
await app.register(mementoPlugin, {
  prefix: "/memento",
  db,
  publisher: bus,
  stream: { feed: bus },
});
await app.listen({ port: 8000 });
