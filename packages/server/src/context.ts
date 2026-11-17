import { AsyncLocalStorage } from "node:async_hooks";
import type { Scope } from "@memento/core";
import { MementoError } from "./errors.js";

/**
 * Who is calling: the tenant the API key (or the session) is bound to, and what it may do.
 * A session (`config.auth`) has `apiKeyId: null`, the scopes `["admin"]` and the user fields.
 */
export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  /** `null` for a session (cookie) request. */
  apiKeyId: string | null;
  scopes: readonly Scope[];
  /** The signed-in user of a session request; `undefined` with an API key. */
  userId?: string;
  userEmail?: string;
  isAdmin?: boolean;
  /**
   * The key's tenant is a self-service one (it has an account member in
   * `memento_tenant_user`), set by `authenticateApiKey`.
   */
  selfService?: boolean;
  /**
   * `false`: the key is neither metered nor held to its daily limit — a key of a tenant
   * without accounts, on a process without `MEMENTO_ACCOUNTS`. Absent or `true`: it is
   * (`isMetered`).
   */
  metered?: boolean;
  /**
   * The locale the request asked its events to be rendered in, when it named one
   * (`X-Memento-Locale` on `/udc/*`); `undefined`: the server's default locale.
   */
  locale?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Runs `fn` with `context` as the current tenant (the Node equivalent of a ContextVar). */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current tenant, or `undefined` outside an authenticated request. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** The current tenant; throws when called outside an authenticated request. */
export function requireTenant(): TenantContext {
  const context = storage.getStore();
  if (!context) throw new MementoError("unauthorized", "no tenant context");
  return context;
}
