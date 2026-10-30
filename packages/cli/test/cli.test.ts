import { connect, loadConfig, MIGRATIONS_FOLDER, schema } from "@memento/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../src/index.js";

const handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
let out: string[];
let err: string[];
const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
const run = (...argv: string[]) => runCli(argv, { db: () => handle.db, io });

beforeEach(async () => {
  out = [];
  err = [];
  await handle.pool.query(
    "truncate memento_seen, memento_star, memento_template, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
  );
});
afterAll(() => handle.close());

describe("memento create-tenant", () => {
  it("creates a tenant", async () => {
    expect(await run("create-tenant", "acme", "--name", "Acme Inc")).toBe(0);
    expect(out[0]).toMatch(/^created tenant acme \(Acme Inc\) id=[0-9a-f-]{36}$/);
    const rows = await handle.db.select().from(schema.tenants);
    expect(rows).toMatchObject([{ slug: "acme", name: "Acme Inc", isActive: true }]);
  });

  it("prints JSON with --json", async () => {
    expect(await run("--json", "create-tenant", "acme", "--name", "Acme")).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ slug: "acme", name: "Acme" });
  });

  it("reports duplicates and invalid slugs as errors", async () => {
    await run("create-tenant", "acme", "--name", "Acme");
    expect(await run("create-tenant", "acme", "--name", "Again")).toBe(1);
    expect(err).toEqual(['error: tenant "acme" already exists']);
    err = [];
    expect(await run("create-tenant", "Not Valid", "--name", "x")).toBe(1);
    expect(err[0]).toMatch(/^error: slug: slug must be lowercase/);
  });

  it("requires --name", async () => {
    expect(await run("create-tenant", "acme")).toBe(1);
    expect(err.join("\n")).toContain("required option '--name <name>' not specified");
  });

  it("lists tenants", async () => {
    expect(await run("list-tenants")).toBe(0);
    expect(out).toEqual(["no tenants"]);
    await run("create-tenant", "acme", "--name", "Acme");
    out = [];
    await run("list-tenants");
    expect(out).toEqual(["acme\tAcme\tactive"]);
  });
});

describe("memento create-key", () => {
  beforeEach(async () => {
    await run("create-tenant", "acme", "--name", "Acme");
    out = [];
  });

  it("generates a key, prints it once and stores only its hash", async () => {
    const code = await run(
      "create-key",
      "--tenant",
      "acme",
      "--scopes",
      "write,read",
      "--name",
      "backend",
    );
    expect(code).toBe(0);
    const key = /key:\s+(mk_\S+)/.exec(out.join("\n"))?.[1] as string;
    expect(key).toMatch(/^mk_[a-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(out[0]?.split("\n")[0]).toBe('created key "backend" for acme [read,write]');
    const [row] = await handle.db.select().from(schema.apiKeys);
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.keyHash).not.toContain(key.slice(12));
    expect(row?.scopes).toEqual(["read", "write"]);
    expect(row?.expiresAt).toBeNull();
  });

  it("supports expiry and JSON output", async () => {
    await run(
      "--json",
      "create-key",
      "--tenant",
      "acme",
      "--scopes",
      "admin",
      "--name",
      "ops",
      "--expires-in-days",
      "30",
    );
    const data = JSON.parse(out[0] as string);
    expect(data.key).toMatch(/^mk_/);
    const days = (Date.parse(data.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it.each([
    [["--scopes", "read,root"], "error: unknown scope(s): root (allowed: read, write, admin)"],
    [["--scopes", "read", "--tenant", "nope"], 'error: tenant "nope" not found'],
  ])("rejects %j", async (args, message) => {
    const base = ["create-key", "--tenant", "acme", "--name", "x", "--scopes", "read"];
    expect(await run(...base, ...args)).toBe(1);
    expect(err).toEqual([message]);
  });

  it("rejects a non-numeric expiry", async () => {
    const code = await run(
      "create-key",
      "--tenant",
      "acme",
      "--scopes",
      "read",
      "--name",
      "x",
      "--expires-in-days",
      "soon",
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("must be a positive integer");
  });

  it("revokes keys by prefix", async () => {
    await run("--json", "create-key", "--tenant", "acme", "--scopes", "read", "--name", "x");
    const { prefix } = JSON.parse(out[0] as string);
    out = [];
    expect(await run("revoke-key", prefix)).toBe(0);
    expect(out).toEqual([`revoked key ${prefix} (x)`]);
    expect(await run("revoke-key", prefix)).toBe(1);
  });
});

describe("other commands", () => {
  it("create-template is a Phase 2 stub that still validates its input", async () => {
    const base = ["create-template", "--tenant", "acme", "--event-type"];
    expect(await run(...base, "USER_LOGIN", "--locale", "sr")).toBe(1);
    expect(err).toEqual([
      "error: create-template is not implemented yet: template rendering arrives in Phase 2",
    ]);
    err = [];
    expect(await run(...base, "user login", "--locale", "sr")).toBe(1);
    expect(err[0]).toMatch(/^error: value: event_type must be SCREAMING_SNAKE_CASE/);
  });

  it("migrate applies migrations", async () => {
    expect(MIGRATIONS_FOLDER).toMatch(/drizzle$/);
    expect(await run("migrate")).toBe(0);
    expect(out).toEqual(["migrations applied"]);
  });

  it("help lists every command and never touches the database", async () => {
    const program = buildProgram({
      db: () => {
        throw new Error("must not connect");
      },
      io,
    });
    const help = program.helpInformation();
    for (const command of [
      "create-tenant",
      "create-key",
      "revoke-key",
      "list-tenants",
      "create-template",
      "migrate",
    ]) {
      expect(help).toContain(command);
    }
    expect(await runCli(["--help"], { db: () => handle.db, io })).toBe(0);
    expect(await run("nope")).toBe(1);
  });

  it("rethrows unexpected errors", async () => {
    await expect(
      runCli(["list-tenants"], {
        db: () => {
          throw new Error("boom");
        },
        io,
      }),
    ).rejects.toThrow("boom");
  });
});
