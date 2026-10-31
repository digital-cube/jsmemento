import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateLookupsModule,
  LookupCompileError,
  validateTranslationsCsv,
} from "@memento/lookups";
import {
  createApiKey,
  createTenant,
  type Database,
  DEFAULT_LOOKUPS_PATH,
  deleteTemplate,
  GENERATED_LOOKUPS_PATH,
  initLookups,
  LOOKUPS_CODEGEN,
  listTemplates,
  listTenants,
  MementoError,
  revokeApiKey,
  runMigrations,
  saveTemplate,
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
    .description("JSMemento administration: tenants, API keys, templates, lookups")
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
    .description("create a per-tenant Handlebars template (overrides the bundled one)")
    .requiredOption("--tenant <slug>", "tenant the template belongs to")
    .requiredOption("--event-type <type>", "e.g. USER_LOGIN, or _generic")
    .requiredOption("--locale <locale>", "e.g. en, sr, sr-Latn")
    .option("--body <template>", 'template body, e.g. "{{actor_id}} logged in"')
    .option("--file <path>", "read the template body from a file")
    .option("--replace", "overwrite an existing template for this event type and locale")
    .action(
      async (options: {
        tenant: string;
        eventType: string;
        locale: string;
        body?: string;
        file?: string;
        replace?: boolean;
      }) => {
        if ((options.body === undefined) === (options.file === undefined)) {
          throw new MementoError("bad_request", "pass exactly one of --body or --file");
        }
        const body =
          options.body ?? (await readFile(options.file as string, "utf8")).replace(/\s+$/, "");
        const { template, created } = await saveTemplate(
          db(),
          options.tenant,
          { event_type: options.eventType, locale: options.locale, body },
          { replace: Boolean(options.replace) },
        );
        print(
          { ...template, created },
          `${created ? "created" : "replaced"} template ${template.event_type}/${template.locale} for ${options.tenant}`,
        );
      },
    );

  program
    .command("list-templates")
    .description("list a tenant's templates")
    .requiredOption("--tenant <slug>")
    .action(async (options: { tenant: string }) => {
      const templates = await listTemplates(db(), options.tenant);
      print(
        templates,
        templates.length === 0
          ? "no templates (the bundled ones are used)"
          : templates
              .map((t) => `${t.event_type}\t${t.locale}\t${t.body.replaceAll("\n", "\\n")}`)
              .join("\n"),
      );
    });

  program
    .command("delete-template")
    .description("delete a tenant's template; rendering falls back to the bundled one")
    .requiredOption("--tenant <slug>")
    .requiredOption("--event-type <type>")
    .requiredOption("--locale <locale>")
    .action(async (options: { tenant: string; eventType: string; locale: string }) => {
      const template = await deleteTemplate(
        db(),
        options.tenant,
        options.eventType,
        options.locale,
      );
      print(
        template,
        `deleted template ${template.event_type}/${template.locale} for ${options.tenant}`,
      );
    });

  const lookups = program
    .command("lookups")
    .description("controlled vocabulary: lookups.yaml + i18n/translations.csv");
  const pathOption = ["--path <file>", "lookups.yaml", DEFAULT_LOOKUPS_PATH] as const;

  lookups
    .command("validate")
    .description("check lookups.yaml and a translations CSV (exit 1 on errors)")
    .option(...pathOption)
    .option("--translations <file>", "default: i18n/translations.csv next to lookups.yaml")
    .action(async (options: { path: string; translations?: string }) => {
      const loaded = await initLookups({ path: options.path, candidatesDir: null });
      const csvPath = options.translations ?? join(options.path, "..", "i18n", "translations.csv");
      const result = validateTranslationsCsv(await readFile(csvPath, "utf8"), loaded.registry);
      const where = (issue: { line: number; column?: string }) =>
        issue.line > 0
          ? `${csvPath}:${issue.line}${issue.column ? ` [${issue.column}]` : ""}`
          : csvPath;
      const sections = loaded.registry.sectionNames();
      print(
        {
          ok: result.ok,
          sections,
          locales: result.locales,
          errors: result.errors,
          warnings: result.warnings,
        },
        [
          `${options.path}: ${sections.map((s) => `${s} (${loaded.registry.terms(s).length})`).join(", ")}`,
          ...result.errors.map((issue) => `error   ${where(issue)}: ${issue.message}`),
          ...result.warnings.map((issue) => `warning ${where(issue)}: ${issue.message}`),
          result.ok
            ? `ok: ${result.locales.join(", ")} — ${result.warnings.length} warning(s)`
            : `${result.errors.length} error(s)`,
        ].join("\n"),
      );
      if (!result.ok) throw new MementoError("validation_error", "translations are invalid");
    });

  lookups
    .command("codegen")
    .description("generate TypeScript enums + Zod schemas from lookups.yaml into @memento/core")
    .option(...pathOption)
    .option("--out <file>", "output module", GENERATED_LOOKUPS_PATH)
    .option("--check", "exit 1 if the output is out of date instead of writing it")
    .action(async (options: { path: string; out: string; check?: boolean }) => {
      const { registry } = await initLookups({ path: options.path, candidatesDir: null });
      const code = generateLookupsModule(registry, LOOKUPS_CODEGEN);
      if (options.check) {
        const current = await readFile(options.out, "utf8").catch(() => "");
        if (current !== code) {
          throw new MementoError(
            "conflict",
            `${options.out} is out of date: run memento lookups codegen`,
          );
        }
        print({ ok: true, out: options.out }, `${options.out} is up to date`);
        return;
      }
      await writeFile(options.out, code);
      print({ ok: true, out: options.out }, `wrote ${options.out}`);
    });

  lookups
    .command("candidates")
    .description("list unknown values recorded at ingestion, waiting to be promoted")
    .option(...pathOption)
    .option("--dir <dir>", "default: var/candidates next to lookups.yaml")
    .action(async (options: { path: string; dir?: string }) => {
      const loaded = await initLookups({
        path: options.path,
        candidatesDir: options.dir ?? join(options.path, "..", "var", "candidates"),
      });
      const recorder = loaded.recorder as NonNullable<typeof loaded.recorder>;
      const all: Record<string, unknown[]> = {};
      const lines: string[] = [];
      for (const section of loaded.registry.sectionNames()) {
        const candidates = await recorder.list(section);
        all[section] = candidates;
        for (const c of candidates) {
          lines.push(`${section}.${c.value}\t${c.count}\t${c.first_seen}\t${c.last_seen}`);
        }
      }
      print(all, lines.length === 0 ? "no candidates" : lines.join("\n"));
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
  const override = (command: Command): void => {
    command.exitOverride();
    for (const child of command.commands) override(child);
  };
  override(program);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof MementoError || error instanceof LookupCompileError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      io.err(`error: ${(error as Error).message}`);
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
