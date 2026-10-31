import { AsyncLocalStorage } from "node:async_hooks";
import type { Scope } from "@memento/core";
import { MementoError } from "./errors.js";

/** Who is calling: the tenant the API key is bound to, and what the key may do. */
export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  apiKeyId: string;
  scopes: readonly Scope[];
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
