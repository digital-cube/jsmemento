import { EventTypeSchema, LocaleSchema } from "@memento/core";
import {
  createApiKey,
  createTenant,
  type Database,
  listTenants,
  MementoError,
  revokeApiKey,
  runMigrations,
} from "@memento/server";
import { Command, CommanderError, InvalidArgumentError } from "commander";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliOptions {
  /** Lazily opens the database: `--help` and validation errors never connect. */
  db: () => Database;
  io?: CliIO;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

/** Builds the `memento` command tree. Exported so tests can drive it in-process. */
export function buildProgram({ db, io = defaultIO }: CliOptions): Command {
  const program = new Command("memento")
    .description("JSMemento administration: tenants, API keys, templates")
    .option("--json", "print machine-readable JSON")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (s) => io.out(s.trimEnd()),
      writeErr: (s) => io.err(s.trimEnd()),
    });

  const json = () => Boolean(program.opts().json);
  const print = (data: unknown, text: string) => io.out(json() ? JSON.stringify(data) : text);

  program
    .command("migrate")
    .description("apply pending database migrations")
    .action(async () => {
      await runMigrations(db());
      print({ ok: true }, "migrations applied");
    });

  program
    .command("create-tenant")
    .description("create a tenant")
    .argument("<slug>", "unique slug, e.g. acme")
    .requiredOption("--name <name>", "display name")
    .action(async (slug: string, options: { name: string }) => {
      const tenant = await createTenant(db(), { slug, name: options.name });
      print(tenant, `created tenant ${tenant.slug} (${tenant.name}) id=${tenant.id}`);
    });

  program
    .command("list-tenants")
    .description("list all tenants")
    .action(async () => {
      const tenants = await listTenants(db());
      print(
        tenants,
        tenants.length === 0
          ? "no tenants"
          : tenants
              .map((t) => `${t.slug}\t${t.name}\t${t.is_active ? "active" : "inactive"}`)
              .join("\n"),
      );
    });

  program
    .command("create-key")
    .description("create an API key; the key is printed once and never stored")
    .requiredOption("--tenant <slug>", "tenant the key is bound to")
    .requiredOption("--scopes <scopes>", "comma separated: read,write,admin")
    .requiredOption("--name <name>", "what the key is for, e.g. backend-prod")
    .option("--expires-in-days <days>", "expire the key after N days", positiveInt)
    .action(
      async (options: { tenant: string; scopes: string; name: string; expiresInDays?: number }) => {
        const { apiKey, key } = await createApiKey(db(), {
          tenant: options.tenant,
          name: options.name,
          scopes: options.scopes,
          ...(options.expiresInDays
            ? { expiresAt: new Date(Date.now() + options.expiresInDays * 86_400_000) }
            : {}),
        });
        print(
          { ...apiKey, key },
          [
            `created key "${apiKey.name}" for ${options.tenant} [${apiKey.scopes.join(",")}]`,
            `prefix: ${apiKey.prefix}`,
            `key:    ${key}`,
            "Store it now: it cannot be shown again.",
          ].join("\n"),
        );
      },
    );

  program
    .command("revoke-key")
    .description("revoke an API key by its prefix (the 8 characters after mk_)")
    .argument("<prefix>")
    .action(async (prefix: string) => {
      const apiKey = await revokeApiKey(db(), prefix);
      print(apiKey, `revoked key ${apiKey.prefix} (${apiKey.name})`);
    });

  program
    .command("create-template")
    .description("create a per-tenant template override (available in Phase 2)")
    .requiredOption("--tenant <slug>", "tenant the template belongs to")
    .requiredOption("--event-type <type>", "e.g. USER_LOGIN")
    .requiredOption("--locale <locale>", "e.g. en, sr")
    .option("--file <path>", "template body file")
    .action((options: { eventType: string; locale: string }) => {
      EventTypeSchema.parse(options.eventType);
      LocaleSchema.parse(options.locale);
      throw new MementoError(
        "bad_request",
        "create-template is not implemented yet: template rendering arrives in Phase 2",
      );
    });

  return program;
}

/**
 * Runs the CLI and returns the process exit code: 0 on success, 1 on a domain error
 * (printed as `error: ...`), commander's own code for usage errors.
 */
export async function runCli(argv: string[], options: CliOptions): Promise<number> {
  const io = options.io ?? defaultIO;
  const program = buildProgram({ ...options, io });
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof MementoError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    if (error instanceof Error && error.name === "ZodError") {
      const issues = (error as Error & { issues: { path: PropertyKey[]; message: string }[] })
        .issues;
      io.err(
        `error: ${issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")}`,
      );
      return 1;
    }
    throw error;
  }
}
