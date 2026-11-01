import type { Row } from "@jsudc/core";
import type { Tone } from "../lib/ui.js";

/** A key as the `api_keys` collection serves it (and `POST /keys` answers it). */
export interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: KeyStatus;
  daily_limit: number | null;
  used_today: number;
  events_24h?: number;
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
}

export type KeyStatus = "active" | "disabled" | "revoked" | "expired";
const STATUSES: readonly KeyStatus[] = ["active", "disabled", "revoked", "expired"];

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A row of `api_keys` / `admin_api_keys` as a key. */
export function keyOf(row: Row): KeyRow {
  const status = STATUSES.includes(row.status as KeyStatus) ? (row.status as KeyStatus) : "active";
  return {
    id: row.__meta.id,
    name: str(row.name) ?? "",
    prefix: str(row.prefix) ?? "",
    scopes: Array.isArray(row.scopes) ? row.scopes.filter((s) => typeof s === "string") : [],
    status,
    daily_limit: num(row.daily_limit),
    used_today: num(row.used_today) ?? 0,
    created_at: str(row.created_at),
    last_used_at: str(row.last_used_at),
    expires_at: str(row.expires_at),
  };
}

export function statusTone(status: KeyStatus): Tone {
  return { active: "ok", disabled: "warn", revoked: "bad", expired: "muted" }[status] as Tone;
}

/** The `KEYS` message of a status: `disabled` reads "paused". */
export function statusTerm(status: KeyStatus): string {
  return `STATUS_${status.toUpperCase()}`;
}

/**
 * Why "New key" is disabled, or `null` when it is not: the address is not verified, or the
 * tenant holds `max` live keys (`live`: the count the list says; `null` while it loads).
 */
export function newKeyBlock(
  verified: boolean,
  live: number | null,
  max: number,
): "unverified" | "max" | null {
  if (!verified) return "unverified";
  if (live !== null && live >= max) return "max";
  return null;
}

/** The lines memento's client programs read (`MEMENTO_URL`, `MEMENTO_API_KEY`). */
export function envLines(origin: string, apiBase: string, key: string): string {
  const url = /^https?:\/\//.test(apiBase) ? apiBase : `${origin.replace(/\/+$/, "")}${apiBase}`;
  return `MEMENTO_URL=${url}\nMEMENTO_API_KEY=${key}`;
}

/** The body of `POST /keys` from the dialog's fields; a message per invalid field. */
export function newKeyBody(
  input: { name: string; read: boolean; write: boolean; expires: string; dailyLimit: string },
  maxDailyLimit: number | null,
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<"name" | "scopes" | "daily_limit", string>> } {
  const errors: Partial<Record<"name" | "scopes" | "daily_limit", string>> = {};
  if (!input.name.trim()) errors.name = "REQUIRED";
  if (!input.read && !input.write) errors.scopes = "SCOPES_REQUIRED";
  const limitText = input.dailyLimit.trim();
  const limit = limitText === "" ? null : Number(limitText);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    errors.daily_limit = "LIMIT_POSITIVE";
  } else if (limit !== null && maxDailyLimit !== null && limit > maxDailyLimit) {
    errors.daily_limit = "LIMIT_RANGE";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name: input.name.trim(),
      scopes: [...(input.read ? ["read"] : []), ...(input.write ? ["write"] : [])],
      // The end of the picked day (UTC): the key works through it.
      ...(input.expires ? { expires_at: `${input.expires}T23:59:59Z` } : {}),
      ...(limit !== null ? { daily_limit: limit } : {}),
    },
  };
}
