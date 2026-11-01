import { type Collection, CollectionRegistry } from "@jsudc/server";
import type { SessionAuth } from "../auth.js";

/**
 * Who may call a collection besides an API key: `session` / `admin` take only the
 * `memento_session` cookie (of an admin); `key_or_session` takes an API key and, when the
 * request carries none, the cookie of any signed-in user for reading (the `menu` of the
 * service site, which has no key).
 */
export type CollectionAuth = SessionAuth | "key_or_session";

/** A collection as memento registers it: jsudc's, plus who may call it. */
export interface MementoCollection extends Collection {
  /** See `CollectionAuth`. Absent: API key, scope by action. */
  auth?: CollectionAuth | undefined;
}

/**
 * jsudc's `CollectionRegistry` with memento's per-collection auth. The metadata stays here:
 * jsudc never sees it, `udcRoutes` asks `authOf(name)` before dispatching.
 */
export class MementoRegistry extends CollectionRegistry {
  private readonly auth = new Map<string, CollectionAuth>();

  override register(collection: MementoCollection): void {
    const { auth, ...rest } = collection;
    super.register(rest);
    if (auth) this.auth.set(rest.name, auth);
    else this.auth.delete(rest.name);
  }

  authOf(name: string): CollectionAuth | null {
    return this.auth.get(name) ?? null;
  }
}

/** The auth of collection `name` in `registry` (`null` for a plain jsudc registry). */
export function collectionAuth(registry: CollectionRegistry, name: string): CollectionAuth | null {
  return registry instanceof MementoRegistry ? registry.authOf(name) : null;
}
