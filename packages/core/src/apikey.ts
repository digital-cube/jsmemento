import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";
import { ScopeSchema } from "./scopes.js";

/** Public view of a stored key: the plaintext is never stored, only its hash. */
export const ApiKeySchema = z.object({
  id: IdSchema,
  tenant_id: IdSchema,
  name: z.string().min(1).max(200),
  prefix: z.string(),
  scopes: z.array(ScopeSchema).min(1),
  created_at: TimestampSchema,
  last_used_at: TimestampSchema.nullable(),
  expires_at: TimestampSchema.nullable(),
  revoked_at: TimestampSchema.nullable(),
  /** `revoked` (CLI) wins over `expired`, which wins over `disabled` (paused by its owner). */
  status: z.enum(["active", "disabled", "revoked", "expired"]),
  /** Events the key may write per UTC day (its own limit, else the server default). */
  daily_limit: z.number().int().nullable(),
  /** Events it wrote today (UTC). */
  used_today: z.number().int().min(0),
  /** The user who created it on the service site; `null` for CLI keys. */
  created_by: IdSchema.nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type ApiKeyStatus = ApiKey["status"];

/** The scopes a user may give a key on the service site (`admin` is CLI-only). */
export const USER_KEY_SCOPES = ["read", "write"] as const;

/** `POST /keys` (session): a key the signed-in user creates for their tenant. */
export const ApiKeyCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(z.enum(USER_KEY_SCOPES)).min(1),
  expires_at: TimestampSchema.optional(),
  /** `null`/absent → the server default (`MEMENTO_DEFAULT_DAILY_LIMIT`). */
  daily_limit: z.number().int().min(1).nullish(),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

/** `PATCH /keys/:id`: rename, or change the daily limit (`null` → the server default). */
export const ApiKeyUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  daily_limit: z.number().int().min(1).nullable().optional(),
});
export type ApiKeyUpdate = z.infer<typeof ApiKeyUpdateSchema>;

const KEY_RE = /^mk_([a-z0-9]{8})_([A-Za-z0-9]{32})$/;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(alphabet: string, length: number): string {
  // Rejection sampling keeps every character uniformly distributed.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/**
 * Generates a new plaintext key `mk_<prefix>_<secret>`. The prefix is stored in clear
 * to find the row; the whole key is only ever stored as `hashApiKey(key)`.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const prefix = randomString(PREFIX_ALPHABET, 8);
  return { key: `mk_${prefix}_${randomString(SECRET_ALPHABET, 32)}`, prefix };
}

/** Splits a well-formed key into its parts; `null` for anything else. */
export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const match = KEY_RE.exec(key);
  return match ? { prefix: match[1] as string, secret: match[2] as string } : null;
}

/** SHA-256 of the full key as lowercase hex (Web Crypto: Node, browsers, workers). */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (for hashes of equal, known length). */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Reads the key from `Authorization: Bearer <key>` or `X-Api-Key: <key>`. */
export function extractApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const authorization = first(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match) return match[1] as string;
  }
  const header = first(headers["x-api-key"])?.trim();
  return header ? header : null;
}
