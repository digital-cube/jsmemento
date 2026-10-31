import { connect, loadConfig, schema } from "@memento/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProgram,
  type CliOptions,
  describeDatabaseUrl,
  friendlyError,
  makeUi,
  oraSpinner,
  type Prompter,
  runCli,
} from "../src/index.js";

const handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
let out: string[];
let err: string[];
const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
const run = (argv: string[], options: Partial<CliOptions> = {}) =>
  runCli(argv, { db: () => handle.db, io, ...options });

beforeEach(async () => {
  out = [];
  err = [];
  await handle.pool.query(
    "truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
  );
});
afterAll(() => handle.close());

/** Answers questions from a script, in order, and records what was asked. */
function scripted(...answers: unknown[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async (options: { message: string; validate?: (v: string) => true | string }) => {
    asked.push(options.message);
    if (answers.length === 0) throw new Error(`unexpected question: ${options.message}`);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string" && options.validate) {
      const valid = options.validate(answer);
      if (valid !== true) throw new Error(`invalid answer "${answer}": ${valid}`);
    }
    return answer;
  };
  return {
    asked,
    input: next as Prompter["input"],
    select: next as Prompter["select"],
    checkbox: next as Prompter["checkbox"],
    confirm: next as Prompter["confirm"],
  };
}

describe("help", () => {
  const commands = buildProgram({ db: () => handle.db, io }).commands.map((c) => c.name());

  it("every command has a description, and examples in its --help", async () => {
    expect(commands).toEqual(expect.arrayContaining(["setup", "tail", "create-key"]));
    for (const command of buildProgram({ db: () => handle.db, io }).commands) {
      expect(command.description(), command.name()).not.toBe("");
    }
    for (const command of commands) {
      out = [];
      expect(await run([command, "--help"])).toBe(0);
      expect(out.join("\n"), command).toContain("Examples:\n  $ memento");
    }
  });

  it("the root help lists examples and the environment", async () => {
    expect(await run(["--help"])).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("memento tail --chat-id chat-123");
    expect(help).toContain("MEMENTO_API_KEY");
  });

  it("points at --help after a usage error", async () => {
    expect(await run(["create-tenant"])).toBe(1);
    expect(err.join("\n")).toContain("missing required argument 'slug'");
    expect(err.join("\n")).toContain("run `memento <command> --help`");
  });
});

describe("friendly errors", () => {
  const failing = (error: Error) => ({
    db: () => {
      throw error;
    },
  });
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

  it("explains an unreachable database instead of a stack trace", async () => {
    const down = connect("postgresql://memento:secret@127.0.0.1:1/jsmemento", { max: 1 });
    try {
      const code = await run(["list-tenants"], {
        db: () => down.db,
        databaseUrl: "postgresql://memento:secret@127.0.0.1:1/jsmemento",
      });
      expect(code).toBe(1);
      expect(err).toEqual([
        "error: cannot connect to PostgreSQL at 127.0.0.1:1/jsmemento",
        "hint: start it with `pnpm db:up`, or point DATABASE_URL at a running server",
      ]);
      expect(err.join("\n")).not.toContain("secret");
    } finally {
      await down.close();
    }
  });

  it("follows the cause chain to the driver's error code", async () => {
    const wrapped = new Error("Failed query: select …", { cause: coded("no relation", "42P01") });
    expect(await run(["list-tenants"], failing(wrapped))).toBe(1);
    expect(err).toEqual([
      "error: the database has no memento tables yet",
      "hint: run `memento migrate` first",
    ]);
    expect(friendlyError(coded("x", "28P01"), "postgres://u:p@db/m")?.message).toBe(
      "PostgreSQL at db:5432/m rejected the user or password",
    );
    expect(friendlyError(coded("x", "3D000"))?.message).toBe(
      "the database in DATABASE_URL (the database) does not exist",
    );
    expect(friendlyError(coded("x", "XX000"))).toBeNull();
    expect(friendlyError("a string")).toBeNull();
    expect(describeDatabaseUrl("not a url")).toBe("the database");
  });

  it("prints the stack trace in debug mode", async () => {
    expect(await run(["list-tenants"], { ...failing(new Error("boom")), debug: true })).toBe(1);
    expect(err[0]).toMatch(/^Error: boom\n\s+at /);
    expect(err.slice(1)).toEqual(["error: unexpected failure: boom"]);
    err = [];
    expect(await run(["list-tenants"], failing("weird" as unknown as Error))).toBe(1);
    expect(err[0]).toBe("error: unexpected failure: weird");
  });
});

describe("colours and spinners", () => {
  it("colours success and errors when asked to", async () => {
    expect(await run(["create-tenant", "acme", "--name", "Acme"], { color: true })).toBe(0);
    expect(out[0]?.startsWith("\u001b[32m✔\u001b[39m created tenant acme")).toBe(true);
    expect(await run(["create-tenant", "acme", "--name", "Acme"], { color: true })).toBe(1);
    expect(err).toEqual(['\u001b[31merror:\u001b[39m tenant "acme" already exists']);
    expect(makeUi(false, null).c.red("plain")).toBe("plain");
  });

  it("the ora spinner starts and stops on stderr", () => {
    expect(() => oraSpinner("Working").stop()).not.toThrow();
  });

  it("shows a spinner around slow steps, but not for --json", async () => {
    const stop = vi.fn();
    const spinner = vi.fn(() => ({ stop }));
    expect(await run(["migrate"], { spinner })).toBe(0);
    expect(spinner).toHaveBeenCalledWith("Applying migrations");
    expect(stop).toHaveBeenCalledOnce();
    expect(await run(["--json", "migrate"], { spinner })).toBe(0);
    expect(spinner).toHaveBeenCalledOnce();
    // The spinner stops when the step fails too.
    expect(await run(["create-tenant", "Bad Slug", "--name", "x"], { spinner })).toBe(1);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe("interactive prompts", () => {
  it("create-tenant asks for the slug and the name", async () => {
    const prompter = scripted("acme-inc", "Acme Inc");
    expect(await run(["create-tenant"], { interactive: true, prompter })).toBe(0);
    expect(prompter.asked).toEqual([
      "Tenant slug (lowercase letters, digits and dashes, e.g. acme)",
      "Display name",
    ]);
    expect(out[0]).toMatch(/^created tenant acme-inc \(Acme Inc\)/);
  });

  it("rejects an invalid slug at the question", async () => {
    const prompter = scripted("Not Valid");
    expect(await run(["create-tenant"], { interactive: true, prompter })).toBe(1);
    expect(err[0]).toMatch(/invalid answer "Not Valid": slug must be lowercase/);
  });

  it("create-key asks for tenant, scopes and name", async () => {
    await run(["create-tenant", "acme", "--name", "Acme"]);
    out = [];
    const prompter = scripted("acme", ["read", "write"], "dashboard");
    expect(await run(["create-key"], { interactive: true, prompter })).toBe(0);
    expect(prompter.asked).toEqual([
      "Tenant",
      "Scopes",
      "What is the key for? (e.g. backend-prod)",
    ]);
    expect(out[0]?.split("\n")[0]).toBe('created key "dashboard" for acme [read,write]');
  });

  it("create-key only asks for what is missing, and needs a tenant to exist", async () => {
    const prompter = scripted();
    expect(
      await run(["create-key", "--scopes", "read", "--name", "x"], { interactive: true, prompter }),
    ).toBe(1);
    expect(err).toEqual(["error: there are no tenants yet: run `memento setup` first"]);
  });

  it("without a terminal a missing option is a usage error, as before", async () => {
    expect(await run(["create-key", "--tenant", "acme", "--name", "x"])).toBe(1);
    expect(err.join("\n")).toContain("required option '--scopes <scopes>' not specified");
    err = [];
    // --json never asks either.
    expect(
      await run(["--json", "create-tenant", "acme"], { interactive: true, prompter: scripted() }),
    ).toBe(1);
    expect(err.join("\n")).toContain("required option '--name <name>' not specified");
  });

  it("setup migrates, creates a tenant and its first key", async () => {
    const prompter = scripted("acme", "Acme", true, ["read"], "first-key");
    expect(await run(["setup"], { interactive: true, prompter })).toBe(0);
    expect(prompter.asked).toEqual([
      "Tenant slug (lowercase letters, digits and dashes, e.g. acme)",
      "Display name",
      "Create an API key for it now?",
      "Scopes",
      "What is the key for? (e.g. backend-prod)",
    ]);
    const text = out.join("\n");
    expect(text).toContain("database is up to date");
    expect(text).toContain("created tenant acme (Acme)");
    expect(text).toContain('created key "first-key" for acme [read]');
    expect(text).toContain("export MEMENTO_TENANT=acme");
    expect(await handle.db.select().from(schema.apiKeys)).toHaveLength(1);
  });

  it("setup can reuse an existing tenant and skip the key", async () => {
    await run(["create-tenant", "acme", "--name", "Acme"]);
    out = [];
    const prompter = scripted(true, "acme", false);
    expect(await run(["setup"], { interactive: true, prompter })).toBe(0);
    expect(prompter.asked[0]).toBe("Use an existing tenant (acme)?");
    expect(await handle.db.select().from(schema.apiKeys)).toHaveLength(0);
  });

  it("setup refuses to run without a terminal", async () => {
    expect(await run(["setup"])).toBe(1);
    expect(err.join("\n")).toContain("`memento setup` asks questions: run it in a terminal");
  });

  it("Ctrl+C at a question cancels with exit code 130", async () => {
    const cancel = Object.assign(new Error("User force closed the prompt"), {
      name: "ExitPromptError",
    });
    expect(await run(["create-tenant"], { interactive: true, prompter: scripted(cancel) })).toBe(
      130,
    );
    expect(err).toEqual(["cancelled"]);
  });
});
