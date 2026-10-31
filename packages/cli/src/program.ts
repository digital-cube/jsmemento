import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChatKindSchema,
  chatInstanceId,
  MementoApiError,
  SCOPES,
  SlugSchema,
  type WebSocketConstructor,
} from "@memento/core";
import {
  generateLookupsModule,
  LookupCompileError,
  validateTranslationsCsv,
} from "@memento/lookups";
import {
  createApiKey,
  createChat,
  createTenant,
  type Database,
  DEFAULT_LOOKUPS_PATH,
  deleteTemplate,
  type EventPublisher,
  EventRenderer,
  emptyLookups,
  GENERATED_LOOKUPS_PATH,
  getTenantBySlug,
  initLookups,
  LOOKUPS_CODEGEN,
  listTemplates,
  listTenants,
  MementoError,
  NoopPublisher,
  revokeApiKey,
  runMigrations,
  runWithTenant,
  saveTemplate,
  sendMessage,
} from "@memento/server";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { friendlyError } from "./errors.js";
import { DEFAULT_SERVER_URL, runTail, TailError } from "./tail.js";
import { inquirerPrompter, makeUi, type Prompter, type SpinnerFactory, type Ui } from "./ui.js";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliOptions {
  /** Lazily opens the database: `--help` and validation errors never connect. */
  db: () => Database;
  io?: CliIO;
  /** Where `send-message` announces its event (default: nowhere). Opened lazily. */
  publisher?: () => EventPublisher;
  /** Locale `send-message` renders in when `--locale` is not given. Default `en`. */
  defaultLocale?: string;
  /** Colours in human output. Default `false` (the process entry point turns it on for a TTY). */
  color?: boolean;
  /** Ask for missing values instead of failing. Default `false` (on for a TTY). */
  interactive?: boolean;
  /** How questions are asked. Default `@inquirer/prompts`. */
  prompter?: Prompter;
  /** Spinner for slow steps; `null` for none (the default). */
  spinner?: SpinnerFactory | null;
  /** Where `DATABASE_URL` points, for error messages. */
  databaseUrl?: string;
  /** Print stack traces of unexpected errors. Default `$MEMENTO_DEBUG`. */
  debug?: boolean;
  /** `tail` stops when this aborts (the entry point aborts on Ctrl+C). */
  signal?: AbortSignal;
  /** `tail`'s HTTP client and WebSocket. Default: the global ones. */
  fetch?: typeof fetch;
  WebSocket?: WebSocketConstructor;
  /** Time zone of `tail`'s timestamps. Default: the system's. */
  timeZone?: string;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function nonNegativeInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("must be 0 or a positive integer");
  }
  return parsed;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

/** `--tenant <slug>`, falling back to `$MEMENTO_TENANT`. */
const tenantOption = () =>
  new Option("--tenant <slug>", "tenant (default: $MEMENTO_TENANT)")
    .env("MEMENTO_TENANT")
    .makeOptionMandatory();

function list(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `Examples:` help text: `[command, what it does]` pairs. */
function examples(...lines: [string, string][]): string {
  const width = Math.max(...lines.map(([command]) => command.length));
  return `\nExamples:\n${lines.map(([command, what]) => `  $ ${command.padEnd(width)}  # ${what}`).join("\n")}`;
}

const SLUG_HINT = "lowercase letters, digits and dashes, e.g. acme";

/** `true`, or why `value` is not a tenant slug. */
function validSlug(value: string): true | string {
  const result = SlugSchema.safeParse(value);
  return result.success ? true : (result.error.issues[0]?.message ?? SLUG_HINT);
}

/** `Acme Inc` from `acme-inc`. */
function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/** Builds the `memento` command tree. Exported so tests can drive it in-process. */
export function buildProgram(options: CliOptions): Command {
  const {
    db,
    io = defaultIO,
    publisher = () => new NoopPublisher(),
    defaultLocale = "en",
    color = false,
    interactive = false,
    prompter = inquirerPrompter,
    spinner = null,
  } = options;
  const program = new Command("memento")
    .description(
      "JSMemento administration: tenants, API keys, templates, chats, lookups, live tail",
    )
    .option("--json", "print machine-readable JSON")
    .showHelpAfterError("(run `memento <command> --help` for the options and examples)")
    .configureOutput({
      writeOut: (s) => io.out(s.trimEnd()),
      writeErr: (s) => io.err(s.trimEnd()),
      outputError: (s, write) => write(color ? makeUi(true, null).c.red(s) : s),
    })
    .addHelpText(
      "after",
      `${examples(
        ["memento setup", "first run: create a tenant and its first API key, step by step"],
        ["memento create-key --tenant acme --scopes read --name dashboard", "a read-only key"],
        ["memento tail --chat-id chat-123", "follow a chat live, like tail -f"],
      )}

Environment:
  DATABASE_URL     PostgreSQL the admin commands use
  MEMENTO_TENANT   default --tenant for chat commands
  MEMENTO_URL      server for \`tail\` (default ${DEFAULT_SERVER_URL})
  MEMENTO_API_KEY  key for \`tail\`
  MEMENTO_DEBUG=1  print stack traces of unexpected errors`,
    );

  const json = () => Boolean(program.opts().json);
  const ui: Ui = makeUi(color, spinner);
  const { c } = ui;
  // Spinners only where a person watches: not for `--json`, which is read by programs.
  const step = <T>(text: string, fn: () => Promise<T>): Promise<T> =>
    json() ? fn() : ui.step(text, fn);
  const print = (data: unknown, text: string) =>
    io.out(json() ? JSON.stringify(data) : color ? `${c.green("✔")} ${text}` : text);
  const asking = () => interactive && !json();
  /** A missing value: asked for in a terminal, otherwise commander's own usage error. */
  const need = async (
    command: Command,
    value: string | undefined,
    flag: string,
    ask: () => Promise<string>,
  ): Promise<string> => {
    if (value !== undefined) return value;
    if (asking()) return ask();
    return command.error(`error: required option '${flag}' not specified`, {
      code: "commander.missingMandatoryOptionValue",
    });
  };

  program
    .command("migrate")
    .description("apply pending database migrations")
    .addHelpText("after", examples(["memento migrate", "bring DATABASE_URL up to date"]))
    .action(async () => {
      await step("Applying migrations", () => runMigrations(db()));
      print({ ok: true }, "migrations applied");
    });

  const askSlug = () =>
    prompter.input({ message: `Tenant slug (${SLUG_HINT})`, validate: validSlug });
  const askTenantName = (slug: string) =>
    prompter.input({ message: "Display name", default: titleCase(slug) });

  program
    .command("create-tenant")
    .description("create a tenant (asks for what is missing when run in a terminal)")
    .argument("[slug]", "unique slug, e.g. acme")
    .option("--name <name>", "display name")
    .addHelpText(
      "after",
      examples(
        ['memento create-tenant acme --name "Acme Inc"', "create the tenant acme"],
        ["memento create-tenant", "be asked for the slug and the name"],
      ),
    )
    .action(async (slugArg: string | undefined, options: { name?: string }, command: Command) => {
      if (slugArg === undefined && !asking()) {
        return command.error("error: missing required argument 'slug'", {
          code: "commander.missingArgument",
        });
      }
      const slug = slugArg ?? (await askSlug());
      const name = await need(command, options.name, "--name <name>", () => askTenantName(slug));
      const tenant = await step("Creating tenant", () => createTenant(db(), { slug, name }));
      print(tenant, `created tenant ${tenant.slug} (${tenant.name}) id=${tenant.id}`);
    });

  program
    .command("list-tenants")
    .description("list all tenants")
    .addHelpText("after", examples(["memento list-tenants --json", "every tenant as JSON"]))
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

  const askTenant = async (): Promise<string> => {
    const tenants = await listTenants(db());
    if (tenants.length === 0) {
      throw new MementoError("not_found", "there are no tenants yet: run `memento setup` first");
    }
    return prompter.select({
      message: "Tenant",
      choices: tenants.map((t) => ({ name: `${t.slug} (${t.name})`, value: t.slug })),
    });
  };
  const askScopes = async (): Promise<string> =>
    (
      await prompter.checkbox({
        message: "Scopes",
        choices: SCOPES.map((scope) => ({ name: scope, value: scope, checked: scope === "read" })),
        required: true,
      })
    ).join(",");
  const askKeyName = () =>
    prompter.input({
      message: "What is the key for? (e.g. backend-prod)",
      validate: (value) => (value.trim() ? true : "give the key a name"),
    });

  const createKey = async (options: {
    tenant: string;
    scopes: string;
    name: string;
    expiresInDays?: number | undefined;
  }) => {
    const { apiKey, key } = await step("Creating key", () =>
      createApiKey(db(), {
        tenant: options.tenant,
        name: options.name,
        scopes: options.scopes,
        ...(options.expiresInDays
          ? { expiresAt: new Date(Date.now() + options.expiresInDays * 86_400_000) }
          : {}),
      }),
    );
    print(
      { ...apiKey, key },
      [
        `created key "${apiKey.name}" for ${options.tenant} [${apiKey.scopes.join(",")}]`,
        `prefix: ${apiKey.prefix}`,
        `key:    ${c.bold(key)}`,
        c.yellow("Store it now: it cannot be shown again."),
      ].join("\n"),
    );
  };

  program
    .command("create-key")
    .description("create an API key; the key is printed once and never stored")
    .option("--tenant <slug>", "tenant the key is bound to")
    .option("--scopes <scopes>", "comma separated: read,write,admin")
    .option("--name <name>", "what the key is for, e.g. backend-prod")
    .option("--expires-in-days <days>", "expire the key after N days", positiveInt)
    .addHelpText(
      "after",
      examples(
        [
          "memento create-key --tenant acme --scopes read,write --name backend-prod",
          "a key for a producer",
        ],
        [
          "memento create-key --tenant acme --scopes read --name ci --expires-in-days 30",
          "a temporary read key",
        ],
        ["memento create-key", "be asked for tenant, scopes and name"],
      ),
    )
    .action(
      async (
        options: { tenant?: string; scopes?: string; name?: string; expiresInDays?: number },
        command: Command,
      ) => {
        const tenant = await need(command, options.tenant, "--tenant <slug>", askTenant);
        const scopes = await need(command, options.scopes, "--scopes <scopes>", askScopes);
        const name = await need(command, options.name, "--name <name>", askKeyName);
        await createKey({ tenant, scopes, name, expiresInDays: options.expiresInDays });
      },
    );

  program
    .command("setup")
    .description("first run, step by step: migrate, create a tenant and its first API key")
    .addHelpText("after", examples(["memento setup", "answer the questions; nothing else needed"]))
    .action(async (_options: unknown, command: Command) => {
      if (!asking()) {
        return command.error(
          "error: `memento setup` asks questions: run it in a terminal, or use migrate, create-tenant and create-key",
          { code: "commander.notInteractive" },
        );
      }
      await step("Applying migrations", () => runMigrations(db()));
      io.out(`${c.green("✔")} database is up to date`);
      const existing = await listTenants(db());
      let slug: string;
      const reuse =
        existing.length > 0 &&
        (await prompter.confirm({
          message: `Use an existing tenant (${existing.map((t) => t.slug).join(", ")})?`,
          default: false,
        }));
      if (reuse) {
        slug = await prompter.select({
          message: "Tenant",
          choices: existing.map((t) => ({ name: `${t.slug} (${t.name})`, value: t.slug })),
        });
      } else {
        slug = await askSlug();
        const name = await askTenantName(slug);
        const tenant = await step("Creating tenant", () => createTenant(db(), { slug, name }));
        print(tenant, `created tenant ${tenant.slug} (${tenant.name})`);
      }
      if (await prompter.confirm({ message: "Create an API key for it now?", default: true })) {
        await createKey({ tenant: slug, scopes: await askScopes(), name: await askKeyName() });
      }
      io.out(
        [
          "",
          "Next:",
          `  ${c.cyan("pnpm dev")}                         start the server`,
          `  ${c.cyan("cd apps/example && pnpm dev")}      open the live table at http://localhost:5173`,
          `  ${c.cyan(`export MEMENTO_TENANT=${slug}`)}`,
        ].join("\n"),
      );
    });

  program
    .command("revoke-key")
    .description("revoke an API key by its prefix (the 8 characters after mk_)")
    .argument("<prefix>")
    .addHelpText("after", examples(["memento revoke-key ab12cd34", "revoke mk_ab12cd34_…"]))
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
    .addHelpText(
      "after",
      examples(
        [
          'memento create-template --tenant acme --event-type USER_LOGIN --locale sr --body "{{actor_id}} se prijavio"',
          "inline body",
        ],
        [
          "memento create-template --tenant acme --event-type _generic --locale en --file generic.hbs --replace",
          "from a file",
        ],
      ),
    )
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
    .addHelpText("after", examples(["memento list-templates --tenant acme", "acme's overrides"]))
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
    .addHelpText(
      "after",
      examples([
        "memento delete-template --tenant acme --event-type USER_LOGIN --locale sr",
        "back to the bundled template",
      ]),
    )
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

  /** Runs `fn` as the tenant `slug` with admin rights, the way an API request would. */
  const asTenant = async <T>(slug: string, fn: () => Promise<T>): Promise<T> => {
    const tenant = await getTenantBySlug(db(), slug);
    return runWithTenant(
      {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        apiKeyId: "cli",
        scopes: ["admin"],
      },
      fn,
    );
  };

  program
    .command("create-chat")
    .description("create a chat (instance_type chat, instance_id chat-<id>)")
    .addOption(tenantOption())
    .requiredOption("--participants <users>", "comma separated user ids, e.g. igor,marko", list)
    .option("--name <name>", 'e.g. "Igor-Marko chat"')
    .addOption(
      new Option("--kind <kind>", "default: direct for two participants, room otherwise").choices(
        ChatKindSchema.options,
      ),
    )
    .option("--chat-id <id>", "your own id (123 or chat-123); default: a generated UUID")
    .addHelpText(
      "after",
      examples(
        [
          'memento create-chat --tenant acme --participants igor,marko --name "Igor-Marko chat"',
          "a direct chat",
        ],
        [
          "memento create-chat --tenant acme --participants igor,marko,ana --chat-id sales",
          "a room with your own id",
        ],
      ),
    )
    .action(
      async (options: {
        tenant: string;
        participants: string[];
        name?: string;
        kind?: "direct" | "room";
        chatId?: string;
      }) => {
        const chat = await asTenant(options.tenant, () =>
          createChat(db(), {
            participants: options.participants,
            ...(options.name !== undefined ? { name: options.name } : {}),
            ...(options.kind ? { kind: options.kind } : {}),
            ...(options.chatId !== undefined ? { chat_id: options.chatId } : {}),
          }),
        );
        print(
          chat,
          `created ${chat.kind} chat ${chat.chat_id}${chat.name ? ` "${chat.name}"` : ""}: ${chat.participants.map((p) => p.user_id).join(", ")}`,
        );
      },
    );

  program
    .command("send-message")
    .description("send a chat message as a participant (pushes CHAT_MESSAGE_SENT)")
    .addOption(tenantOption())
    .requiredOption("--chat-id <id>", "chat-<id> (or just <id>)")
    .requiredOption("--user <user>", "sender; must be a participant")
    .requiredOption("--content <text>", "message text")
    .option("--locale <locale>", "locale the message is rendered in")
    .addHelpText(
      "after",
      examples([
        'memento send-message --tenant acme --chat-id chat-123 --user igor --content "Pozdrav!"',
        "send as igor",
      ]),
    )
    .action(
      async (options: {
        tenant: string;
        chatId: string;
        user: string;
        content: string;
        locale?: string;
      }) => {
        const database = db();
        const vocabulary = existsSync(DEFAULT_LOOKUPS_PATH)
          ? await initLookups({ path: DEFAULT_LOOKUPS_PATH, candidatesDir: null })
          : emptyLookups();
        const renderer = new EventRenderer({
          db: database,
          registry: vocabulary.registry,
          defaultLocale,
        });
        const result = await asTenant(options.tenant, () =>
          sendMessage(
            database,
            chatInstanceId(options.chatId),
            { user_id: options.user, content: options.content },
            {
              publisher: publisher(),
              renderer,
              lookups: vocabulary,
              ...(options.locale ? { locale: options.locale } : {}),
              onPublishError: (error) =>
                io.err(`warning: message stored but not published: ${(error as Error).message}`),
            },
          ),
        );
        print(
          result,
          `sent ${result.event_id} to ${result.message.instance_id}: ${result.rendered}`,
        );
      },
    );

  program
    .command("tail")
    .description("print new events as they are stored, like tail -f (via the server's /ws)")
    .option("--chat-id <id>", "follow one chat's messages: 123 or chat-123")
    .option("--event-type <type>", "exact, or a prefix: CHAT_*")
    .option("--instance-type <type>")
    .option("--instance-id <id>", "exact, or a prefix: igor-*")
    .option("--actor <id>", "only what this actor did")
    .option("--locale <locale>", "render the stories in this locale")
    .option("-n, --lines <n>", "show the last N events first (0: none)", nonNegativeInt, 10)
    .addOption(
      new Option("--url <url>", "server API base URL")
        .env("MEMENTO_URL")
        .default(DEFAULT_SERVER_URL),
    )
    .addOption(new Option("--api-key <key>", "key with the read scope").env("MEMENTO_API_KEY"))
    .addHelpText(
      "after",
      `${examples(
        ["memento tail --chat-id chat-123", "[10:00:00] igor: Pozdrav!"],
        ["memento tail --event-type USER_* -n 0", "only new user events"],
        ["memento tail --json | jq .rendered", "one JSON event per line"],
      )}

Runs until Ctrl+C and reconnects by itself; connection notices go to stderr.`,
    )
    .action(
      async (flags: {
        chatId?: string;
        eventType?: string;
        instanceType?: string;
        instanceId?: string;
        actor?: string;
        locale?: string;
        lines: number;
        url: string;
        apiKey?: string;
      }) =>
        runTail(flags, {
          io,
          ui,
          json: json(),
          signal: options.signal,
          fetch: options.fetch,
          WebSocket: options.WebSocket,
          timeZone: options.timeZone,
        }),
    );

  const lookups = program
    .command("lookups")
    .description("controlled vocabulary: lookups.yaml + i18n/translations.csv")
    .addHelpText(
      "after",
      examples(
        ["memento lookups validate", "check lookups.yaml and the translations"],
        ["memento lookups codegen --check", "fail when the generated enums are stale"],
        ["memento lookups candidates", "unknown values waiting to be promoted"],
      ),
    );
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

/** `: path: message; …` for a list of Zod issues, empty for any other details. */
function issueText(details: unknown): string {
  if (!Array.isArray(details)) return "";
  const issues = details.filter(
    (i): i is { path?: PropertyKey[]; message: string } =>
      typeof i === "object" && i !== null && typeof i.message === "string",
  );
  if (issues.length === 0) return "";
  return `: ${issues.map((i) => (i.path?.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ")}`;
}

/**
 * Runs the CLI and returns the process exit code: 0 on success, 1 on an error (printed as
 * `error: ...`, with a hint when there is one — never a stack trace unless `debug`), 130 when
 * a question was cancelled with Ctrl+C, commander's own code for usage errors.
 */
export async function runCli(argv: string[], options: CliOptions): Promise<number> {
  const io = options.io ?? defaultIO;
  const program = buildProgram({ ...options, io });
  const { c } = makeUi(options.color ?? false, null);
  const fail = (message: string, hint?: string): number => {
    io.err(`${c.red("error:")} ${message}`);
    if (hint) io.err(c.dim(`hint: ${hint}`));
    return 1;
  };
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
    if (error instanceof MementoError) return fail(`${error.message}${issueText(error.details)}`);
    if (error instanceof LookupCompileError || error instanceof TailError) {
      return fail(error.message);
    }
    if (error instanceof MementoApiError) {
      return fail(
        error.message,
        error.code === "unauthorized"
          ? "check --api-key / MEMENTO_API_KEY"
          : error.code === "network_error"
            ? "is the server running? start it with `pnpm dev`, or pass --url / MEMENTO_URL"
            : undefined,
      );
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fail((error as Error).message);
    }
    if (error instanceof Error && error.name === "ExitPromptError") {
      io.err(c.dim("cancelled"));
      return 130;
    }
    if (error instanceof Error && error.name === "ZodError") {
      const issues = (error as Error & { issues: { path: PropertyKey[]; message: string }[] })
        .issues;
      return fail(issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
    }
    const friendly = friendlyError(error, options.databaseUrl);
    if (friendly) return fail(friendly.message, friendly.hint);
    const debug = options.debug ?? Boolean(process.env.MEMENTO_DEBUG);
    if (debug && error instanceof Error && error.stack) io.err(error.stack);
    return fail(
      `unexpected failure: ${error instanceof Error ? error.message : String(error)}`,
      debug ? undefined : "set MEMENTO_DEBUG=1 to see the stack trace",
    );
  }
}
