import { LocaleSchema } from "@memento/core";
import { z } from "zod";
import { DEFAULT_LOOKUPS_PATH } from "./lookups.js";

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
});

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
}

/** Reads the configuration from the environment (see `.env.example`). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")),
  );
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
  };
}
