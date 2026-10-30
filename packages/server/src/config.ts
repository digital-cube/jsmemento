import { z } from "zod";

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
  };
}
