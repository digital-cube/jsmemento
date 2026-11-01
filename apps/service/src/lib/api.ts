/**
 * The memento API under this origin: `/memento` (the Vite proxy in development, the same
 * server in production).
 */
export const API_BASE = (import.meta.env.VITE_MEMENTO_BASE_URL || "/memento").replace(/\/+$/, "");

/** A `{ok: false, error}` answer (or a transport failure, `status` 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * One call of memento's account and key routes (`/auth/*`, `/keys*`, `/admin/*`): writes, not
 * list data — lists are UDC collections. The session cookie authenticates
 * (`credentials: "include"`, same origin anyway); every write names `application/json`, the
 * server's CSRF guard, even with nothing to send. Answers `data`; throws `ApiError`.
 */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(method === "GET" ? {} : { "content-type": "application/json" }),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  } catch (error) {
    throw new ApiError(0, "network", error instanceof Error ? error.message : String(error));
  }
  if (response.status === 204) return undefined as T;
  const json = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  if (!response.ok || !json || json.ok === false) {
    throw new ApiError(
      response.status,
      json?.error?.code ?? "internal_error",
      json?.error?.message ?? response.statusText,
      json?.error?.details,
    );
  }
  return json.data as T;
}

/**
 * The field a `validation_error` names (`"password: …"`, or its zod issue's `path`), so the
 * form can show it under that field; `null` when it names none.
 */
export function errorField(error: ApiError): string | null {
  const issues = Array.isArray(error.details) ? error.details : [];
  const path = (issues[0] as { path?: unknown[] } | undefined)?.path;
  if (Array.isArray(path) && typeof path[0] === "string") return path[0];
  const m = /^([a-z_]+)(?:\.[a-z_]+)*: /.exec(error.message);
  return m ? (m[1] as string) : null;
}

/** The message of `error` without the `field: ` the server puts in front of it. */
export function errorText(error: ApiError): string {
  return error.message.replace(/^[a-z_.]+: /, "");
}
