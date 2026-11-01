import { LocaleSchema } from "@memento/core";
import { z } from "zod";
import { DEFAULT_LOOKUPS_PATH } from "./lookups.js";
import { DEFAULT_MENU_PATH } from "./udc/menu.js";

const booleanish = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");

const ConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://jsmemento:jsmemento@localhost:5432/jsmemento"),
  TEST_DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://jsmemento:jsmemento@localhost:5432/jsmemento_test"),
  REDIS_URL: z.string().optional(),
  REDIS_CHANNEL_PREFIX: z.string().min(1).default("memento:events"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MEMENTO_API_PREFIX: z
    .string()
    .regex(/^\/[\w/-]*$/)
    .default("/memento"),
  MEMENTO_DEFAULT_LOCALE: LocaleSchema.default("en"),
  MEMENTO_LOOKUPS_PATH: z.string().optional(),
  MEMENTO_TRANSLATIONS_PATH: z.string().optional(),
  MEMENTO_CANDIDATES_DIR: z.string().optional(),
  MEMENTO_RECORD_CANDIDATES: booleanish.default(true),
  MEMENTO_LOOKUPS_STRICT: booleanish.default(false),
  MEMENTO_WS_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(30_000),
  MEMENTO_WS_MAX_BUFFERED: z.coerce.number().int().min(1).default(1000),
  MEMENTO_UI_DIR: z.string().optional(),
  MEMENTO_MENU_PATH: z.string().optional(),
  MEMENTO_DEMO_API_KEY: z.string().optional(),
  MEMENTO_ACCOUNTS: booleanish.default(false),
  MEMENTO_SERVICE_URL: z.url({ protocol: /^https?$/ }).optional(),
  MEMENTO_BREVO_API_KEY: z.string().optional(),
  MEMENTO_MAIL_FROM: z.string().optional(),
  MEMENTO_TRUST_PROXY: booleanish.default(false),
  MEMENTO_SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MEMENTO_DEFAULT_MAX_KEYS: z.coerce.number().int().min(0).default(10),
  MEMENTO_DEFAULT_DAILY_LIMIT: z.coerce.number().int().min(0).default(100_000),
  MEMENTO_MAX_DAILY_LIMIT: z.coerce.number().int().min(0).optional(),
});

/** `Name <address>` (or a bare address) → sender of the transactional mails. */
export function parseMailFrom(value: string): { name: string; email: string } {
  const match = /^\s*(?:"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/.exec(value);
  if (!match) throw new Error(`MEMENTO_MAIL_FROM must be "Name <address>", got "${value}"`);
  const email = (match[2] ?? match[3]) as string;
  return { name: match[1]?.trim() || email, email };
}

/** Self-service accounts (`MEMENTO_ACCOUNTS`): the auth routes and the session credential. */
export interface AccountsConfig {
  /** Public origin of the service site, without a trailing slash: links in mails. */
  serviceUrl: string;
  /** `null` → mails are logged (`LogMailer`), not sent. */
  brevoApiKey: string | null;
  /** Sender of the mails; required with a Brevo key. */
  mailFrom: { name: string; email: string } | null;
  sessionDays: number;
}

/** Quota defaults a tenant without its own values gets (read by the keys management). */
export interface LimitsConfig {
  defaultMaxKeys: number;
  defaultDailyLimit: number;
  /** Ceiling of a tenant's daily limit; `null` → none. */
  maxDailyLimit: number | null;
}

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string;
  redisUrl: string | null;
  redisChannelPrefix: string;
  host: string;
  port: number;
  logLevel: z.infer<typeof ConfigSchema>["LOG_LEVEL"];
  apiPrefix: string;
  /** Locale events are rendered in when the request names none. */
  defaultLocale: string;
  lookups: {
    path: string;
    /** `undefined` → `<dir of path>/i18n/translations.csv`. */
    translationsPath: string | undefined;
    /** `undefined` → `<dir of path>/var/candidates`; `null` → recording off. */
    candidatesDir: string | null | undefined;
    strict: boolean;
  };
  /** WebSocket stream `/ws`. */
  stream: {
    heartbeatIntervalMs: number;
    /** Unwritten messages per connection before it is dropped as a slow consumer. */
    maxBufferedMessages: number;
  };
  /** Built web UI served at `/` and `/en/` (`MEMENTO_UI_DIR`); `null` → API only. */
  uiDir: string | null;
  /** The menu YAML served as the `menu` UDC collection (`MEMENTO_MENU_PATH`). */
  menuPath: string;
  /**
   * A read-only key `GET /api/demo` hands to the examples site (`MEMENTO_DEMO_API_KEY`);
   * `null` → no demo key, the route answers 404.
   */
  demoApiKey: string | null;
  /** `null` → `MEMENTO_ACCOUNTS` is off: no auth routes, no session credential. */
  accounts: AccountsConfig | null;
  limits: LimitsConfig;
  /** Fastify `trustProxy` (`MEMENTO_TRUST_PROXY`): honour `X-Forwarded-*` from nginx. */
  trustProxy: boolean;
}

/** Reads the configuration from the environment (see `.env.example`). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")),
  );
  let accounts: AccountsConfig | null = null;
  if (parsed.MEMENTO_ACCOUNTS) {
    if (!parsed.MEMENTO_SERVICE_URL) {
      throw new Error("MEMENTO_SERVICE_URL is required when MEMENTO_ACCOUNTS is on");
    }
    const brevoApiKey = parsed.MEMENTO_BREVO_API_KEY?.trim() || null;
    const from = parsed.MEMENTO_MAIL_FROM?.trim();
    if (brevoApiKey && !from) {
      throw new Error("MEMENTO_MAIL_FROM is required with MEMENTO_BREVO_API_KEY");
    }
    accounts = {
      serviceUrl: parsed.MEMENTO_SERVICE_URL.replace(/\/+$/, ""),
      brevoApiKey,
      mailFrom: from ? parseMailFrom(from) : null,
      sessionDays: parsed.MEMENTO_SESSION_DAYS,
    };
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    testDatabaseUrl: parsed.TEST_DATABASE_URL,
    redisUrl: parsed.REDIS_URL ?? null,
    redisChannelPrefix: parsed.REDIS_CHANNEL_PREFIX,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    apiPrefix: parsed.MEMENTO_API_PREFIX.replace(/\/+$/, ""),
    defaultLocale: parsed.MEMENTO_DEFAULT_LOCALE,
    lookups: {
      path: parsed.MEMENTO_LOOKUPS_PATH ?? DEFAULT_LOOKUPS_PATH,
      translationsPath: parsed.MEMENTO_TRANSLATIONS_PATH,
      candidatesDir: parsed.MEMENTO_RECORD_CANDIDATES ? parsed.MEMENTO_CANDIDATES_DIR : null,
      strict: parsed.MEMENTO_LOOKUPS_STRICT,
    },
    stream: {
      heartbeatIntervalMs: parsed.MEMENTO_WS_HEARTBEAT_MS,
      maxBufferedMessages: parsed.MEMENTO_WS_MAX_BUFFERED,
    },
    uiDir: parsed.MEMENTO_UI_DIR ?? null,
    menuPath: parsed.MEMENTO_MENU_PATH ?? DEFAULT_MENU_PATH,
    demoApiKey: parsed.MEMENTO_DEMO_API_KEY?.trim() || null,
    accounts,
    limits: {
      defaultMaxKeys: parsed.MEMENTO_DEFAULT_MAX_KEYS,
      defaultDailyLimit: parsed.MEMENTO_DEFAULT_DAILY_LIMIT,
      maxDailyLimit: parsed.MEMENTO_MAX_DAILY_LIMIT ?? null,
    },
    trustProxy: parsed.MEMENTO_TRUST_PROXY,
  };
}
