import { buildApp, connect, loadConfig, MemoryPublisher, schema } from "@jsmemento/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { onSqlite, reset } from "../../server/test/helpers.js";
import { describeDatabaseUrl, friendlyError, runCli } from "../src/index.js";

/**
 * The CLI on a SQLite file (this file is not part of the PostgreSQL project): a command next
 * to a running server on the same file, and the messages SQLite errors get.
 */
describe.runIf(onSqlite)("memento on a SQLite file", () => {
  // Two handles on the test file: the server's and the command's — two connections, which
  // SQLite locks against each other as it locks two processes.
  const server = connect(loadConfig().testDatabaseUrl);
  const cli = connect(loadConfig().testDatabaseUrl);
  let out: string[];
  let err: string[];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const run = (...argv: string[]) => runCli(argv, { db: () => cli.db, io });

  beforeEach(async () => {
    out = [];
    err = [];
    await reset(server);
  });
  afterAll(async () => {
    await cli.close();
    await server.close();
  });

  it("runs commands while a server on the same file is up and holding its write lock", async () => {
    const app = await buildApp({ db: server.db, publisher: new MemoryPublisher(), logger: false });
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let begun!: () => void;
      const isBegun = new Promise<void>((resolve) => {
        begun = resolve;
      });
      // The server in the middle of a write transaction.
      const held = server.db.transaction(async (tx) => {
        await tx.insert(schema.tenants).values({ slug: "server-side", name: "Server" });
        begun();
        await released;
      });
      await isBegun;
      const command = run("create-tenant", "acme", "--name", "Acme");
      // Meanwhile the server answers: reads do not wait for the writer.
      const health = await app.inject({ method: "GET", url: "/memento/api/health" });
      expect(health.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await held;
      expect(await command, err.join("\n")).toBe(0);
      expect(await run("create-key", "--tenant", "acme", "--scopes", "read", "--name", "k")).toBe(
        0,
      );
      const tenants = await server.db.select({ slug: schema.tenants.slug }).from(schema.tenants);
      expect(tenants.map((t) => t.slug).sort()).toEqual(["acme", "server-side"]);
      const key = (await server.db.select().from(schema.apiKeys)).find((k) => k.name === "k");
      // The key the command made authenticates on the running server at once.
      const token = out.join("\n").match(/mk_\S+/)?.[0];
      expect(key?.scopes).toEqual(["read"]);
      const listed = await app.inject({
        method: "GET",
        url: "/memento/events",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(err).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("names the SQLite file and explains a busy file or a missing migration", () => {
    expect(describeDatabaseUrl("file:///var/lib/memento/memento.db")).toBe(
      "SQLite /var/lib/memento/memento.db",
    );
    expect(describeDatabaseUrl(":memory:")).toBe("SQLite :memory:");
    expect(describeDatabaseUrl("file://host/x.db")).toBe("the database");
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(friendlyError(new Error("Failed query", { cause: busy }), "file:///srv/m.db")).toEqual({
      message: "SQLite /srv/m.db is busy: another process held its write lock too long",
      hint: "retry in a moment",
    });
    expect(friendlyError(new Error("no such table: memento_tenant"))).toEqual({
      message: "the database has no memento tables yet",
      hint: "run `memento migrate` first",
    });
  });
});
