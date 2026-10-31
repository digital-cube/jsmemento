import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  GENERATED_LOOKUPS_PATH,
  loadConfig,
  MemoryPublisher,
  MIGRATIONS_FOLDER,
  schema,
} from "@memento/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
    "truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
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
      "list-templates",
      "delete-template",
      "lookups",
      "migrate",
    ]) {
      expect(help).toContain(command);
    }
    expect(await runCli(["--help"], { db: () => handle.db, io })).toBe(0);
    expect(await run("nope")).toBe(1);
  });

  it("reports unexpected errors without a stack trace", async () => {
    const code = await runCli(["list-tenants"], {
      db: () => {
        throw new Error("boom");
      },
      io,
      debug: false,
    });
    expect(code).toBe(1);
    expect(err).toEqual([
      "error: unexpected failure: boom",
      "hint: set MEMENTO_DEBUG=1 to see the stack trace",
    ]);
  });
});

describe("memento create-chat / send-message", () => {
  beforeEach(async () => {
    await run("create-tenant", "acme", "--name", "Acme");
    out = [];
  });
  afterEach(() => {
    delete process.env.MEMENTO_TENANT;
  });

  it("creates a chat and sends a rendered, published message", async () => {
    const created = await run(
      "create-chat",
      "--tenant",
      "acme",
      "--participants",
      "igor, marko",
      "--name",
      "Igor-Marko chat",
    );
    expect(created).toBe(0);
    const match = /^created direct chat (chat-[0-9a-f-]{36}) "Igor-Marko chat": igor, marko$/.exec(
      out[0] as string,
    );
    expect(match).not.toBeNull();
    const chatId = match?.[1] as string;
    const publisher = new MemoryPublisher();
    out = [];
    const code = await runCli(
      [
        "--json",
        "send-message",
        "--tenant",
        "acme",
        "--chat-id",
        chatId,
        "--user",
        "igor",
        "--content",
        "Zdravo!",
        "--locale",
        "sr",
      ],
      { db: () => handle.db, io, publisher: () => publisher },
    );
    expect(code).toBe(0);
    const result = JSON.parse(out[0] as string);
    expect(result).toMatchObject({
      rendered: 'igor je poslao poruku: "Zdravo!"',
      message: {
        event_type: "CHAT_MESSAGE_SENT",
        instance_type: "chat",
        instance_id: chatId,
        payload: { content: "Zdravo!", sender_user_id: "igor" },
      },
    });
    expect(publisher.messages.map((m) => m.event.id)).toEqual([result.event_id]);
    const [row] = await handle.db.select().from(schema.chats);
    expect(row?.lastMessageAt).not.toBeNull();
  });

  it("takes the tenant from $MEMENTO_TENANT, a room kind and the producer's id", async () => {
    process.env.MEMENTO_TENANT = "acme";
    expect(
      await run("create-chat", "--participants", "a,b", "--kind", "room", "--chat-id", "42"),
    ).toBe(0);
    expect(out).toEqual(["created room chat chat-42: a, b"]);
    out = [];
    expect(await run("send-message", "--chat-id", "42", "--user", "b", "--content", "hi")).toBe(0);
    expect(out[0]).toMatch(/^sent [0-9a-f-]{36} to chat-42: b sent a message: "hi"$/);
  });

  it("reports domain and usage errors", async () => {
    expect(await run("create-chat", "--participants", "a,b")).toBe(1);
    expect(err.join("\n")).toContain("required option '--tenant <slug>' not specified");
    err = [];
    expect(
      await run("create-chat", "--tenant", "acme", "--participants", "a,b,c", "--kind", "direct"),
    ).toBe(1);
    expect(err).toEqual([
      "error: invalid chat: participants: a direct chat has exactly two distinct participants",
    ]);
    err = [];
    expect(await run("create-chat", "--tenant", "nope", "--participants", "a,b")).toBe(1);
    expect(err).toEqual(['error: tenant "nope" not found']);
    await run("create-chat", "--tenant", "acme", "--participants", "a,b", "--chat-id", "1");
    err = [];
    const send = (user: string, chat = "chat-1") =>
      run("send-message", "--tenant", "acme", "--chat-id", chat, "--user", user, "--content", "x");
    expect(await send("eve")).toBe(1);
    expect(err).toEqual(['error: user "eve" is not a participant of chat-1']);
    err = [];
    expect(await send("a", "missing")).toBe(1);
    expect(err).toEqual(['error: chat "chat-missing" not found']);
  });
});

describe("memento create-template", () => {
  let dir: string;
  beforeEach(async () => {
    await run("create-tenant", "acme", "--name", "Acme");
    out = [];
    dir = await mkdtemp(join(tmpdir(), "memento-cli-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const base = ["create-template", "--tenant", "acme", "--event-type", "USER_LOGIN", "--locale"];

  it("writes a template into memento_template from --body or --file", async () => {
    expect(await run(...base, "en", "--body", "{{actor_id}} came in")).toBe(0);
    expect(out).toEqual(["created template USER_LOGIN/en for acme"]);
    await writeFile(join(dir, "t.hbs"), "Korisnik {{actor_id}} je tu\n\n");
    expect(await run("--json", ...base, "sr", "--file", join(dir, "t.hbs"))).toBe(0);
    expect(JSON.parse(out[1] as string)).toMatchObject({
      locale: "sr",
      body: "Korisnik {{actor_id}} je tu",
      created: true,
    });
    const rows = await handle.db.select().from(schema.templates);
    expect(rows.map((r) => [r.eventType, r.locale, r.body]).sort()).toEqual([
      ["USER_LOGIN", "en", "{{actor_id}} came in"],
      ["USER_LOGIN", "sr", "Korisnik {{actor_id}} je tu"],
    ]);
  });

  it("refuses a duplicate unless --replace", async () => {
    await run(...base, "en", "--body", "v1");
    expect(await run(...base, "en", "--body", "v2")).toBe(1);
    expect(err[0]).toMatch(/already exists for "acme" \(use replace\)/);
    expect(await run(...base, "en", "--body", "v2", "--replace")).toBe(0);
    expect(out.at(-1)).toBe("replaced template USER_LOGIN/en for acme");
  });

  it.each([
    [["en"], "error: pass exactly one of --body or --file"],
    [["en", "--body", "x", "--file", "y"], "error: pass exactly one of --body or --file"],
    [["en", "--body", "{{> partial}}"], "error: invalid template: templates may not use partials"],
    [["en", "--file", "/nonexistent/t.hbs"], /^error: ENOENT/],
    [
      ["EN", "--body", "x"],
      "error: invalid template: locale: locale must look like en, sr or sr-Latn",
    ],
  ])("rejects %j", async (args, message) => {
    expect(await run(...base, ...args)).toBe(1);
    if (typeof message === "string") expect(err).toEqual([message]);
    else expect(err[0]).toMatch(message);
  });

  it("lists and deletes templates", async () => {
    expect(await run("list-templates", "--tenant", "acme")).toBe(0);
    expect(out).toEqual(["no templates (the bundled ones are used)"]);
    await run(...base, "en", "--body", "line1\nline2");
    await run(
      "create-template",
      "--tenant",
      "acme",
      "--event-type",
      "_generic",
      "--locale",
      "sr",
      "--body",
      "g",
    );
    out = [];
    await run("list-templates", "--tenant", "acme");
    expect(out).toEqual(["USER_LOGIN\ten\tline1\\nline2\n_generic\tsr\tg"]);
    out = [];
    expect(
      await run(
        "delete-template",
        "--tenant",
        "acme",
        "--event-type",
        "_generic",
        "--locale",
        "sr",
      ),
    ).toBe(0);
    expect(out).toEqual(["deleted template _generic/sr for acme"]);
    expect(
      await run(
        "delete-template",
        "--tenant",
        "acme",
        "--event-type",
        "_generic",
        "--locale",
        "sr",
      ),
    ).toBe(1);
  });
});

describe("memento lookups", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memento-cli-lookups-"));
    await mkdir(join(dir, "i18n"));
    await writeFile(join(dir, "lookups.yaml"), "EventTypes: [USER_LOGIN]\nInstanceTypes: [USER]\n");
    await writeFile(
      join(dir, "i18n", "translations.csv"),
      "section,term,en,sr\nEventTypes,USER_LOGIN,User login,Prijava\nInstanceTypes,USER,User,\n",
    );
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const yaml = () => join(dir, "lookups.yaml");

  it("validate reports sections, warnings and errors with file:line", async () => {
    expect(await run("lookups", "validate", "--path", yaml())).toBe(0);
    expect(out[0]?.split("\n")).toEqual([
      `${yaml()}: EventTypes (1), InstanceTypes (1)`,
      `warning ${join(dir, "i18n", "translations.csv")}:3 [sr]: InstanceTypes.USER has no sr translation`,
      "ok: en, sr — 1 warning(s)",
    ]);
    await writeFile(join(dir, "bad.csv"), "section,term,en\nEventTypes,NOPE,x\n");
    out = [];
    expect(
      await run(
        "--json",
        "lookups",
        "validate",
        "--path",
        yaml(),
        "--translations",
        join(dir, "bad.csv"),
      ),
    ).toBe(1);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      ok: false,
      errors: [{ line: 2, column: "term", message: 'unknown term "NOPE" in EventTypes' }],
    });
    expect(err).toEqual(["error: translations are invalid"]);
  });

  it("validate fails on invalid YAML", async () => {
    await writeFile(yaml(), "EventTypes: [lower]\n");
    expect(await run("lookups", "validate", "--path", yaml())).toBe(1);
    expect(err[0]).toMatch(/term "lower" must be UPPER_SNAKE_CASE/);
  });

  it("codegen writes the module and --check detects drift", async () => {
    const outFile = join(dir, "gen.ts");
    expect(await run("lookups", "codegen", "--path", yaml(), "--out", outFile, "--check")).toBe(1);
    expect(err[0]).toMatch(/is out of date: run memento lookups codegen/);
    expect(await run("lookups", "codegen", "--path", yaml(), "--out", outFile)).toBe(0);
    expect(await readFile(outFile, "utf8")).toContain(
      'export const INSTANCE_TYPES = ["user"] as const;',
    );
    expect(await run("lookups", "codegen", "--path", yaml(), "--out", outFile, "--check")).toBe(0);
    expect(out.at(-1)).toBe(`${outFile} is up to date`);
  });

  it("codegen --check passes for the repository's committed module", async () => {
    expect(await run("lookups", "codegen", "--check")).toBe(0);
    expect(out).toEqual([`${GENERATED_LOOKUPS_PATH} is up to date`]);
  });

  it("candidates lists recorded unknown values", async () => {
    expect(await run("lookups", "candidates", "--path", yaml())).toBe(0);
    expect(out).toEqual(["no candidates"]);
    await mkdir(join(dir, "var", "candidates"), { recursive: true });
    await writeFile(
      join(dir, "var", "candidates", "EventTypes.yaml"),
      "- value: INVOICE_PAID\n  count: 3\n  first_seen: 2026-10-30T10:00:00Z\n  last_seen: 2026-10-31T10:00:00Z\n",
    );
    out = [];
    await run("lookups", "candidates", "--path", yaml());
    expect(out).toEqual(["EventTypes.INVOICE_PAID\t3\t2026-10-30T10:00:00Z\t2026-10-31T10:00:00Z"]);
    out = [];
    await run(
      "--json",
      "lookups",
      "candidates",
      "--path",
      yaml(),
      "--dir",
      join(dir, "var", "candidates"),
    );
    expect(JSON.parse(out[0] as string)).toMatchObject({
      EventTypes: [{ value: "INVOICE_PAID", count: 3 }],
      InstanceTypes: [],
    });
  });
});
