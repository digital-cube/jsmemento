import { type Collection, CollectionRegistry } from "@jsudc/server";
import type { SessionAuth } from "../auth.js";

/** A collection as memento registers it: jsudc's, plus who may call it. */
export interface MementoCollection extends Collection {
  /**
   * `session` / `admin`: the collection is read with the `memento_session` cookie of a
   * signed-in user (an admin) and refuses API keys. Absent: API key, scope by action.
   */
  auth?: SessionAuth | undefined;
}

/**
 * jsudc's `CollectionRegistry` with memento's per-collection auth. The metadata stays here:
 * jsudc never sees it, `udcRoutes` asks `authOf(name)` before dispatching.
 */
export class MementoRegistry extends CollectionRegistry {
  private readonly auth = new Map<string, SessionAuth>();

  override register(collection: MementoCollection): void {
    const { auth, ...rest } = collection;
    super.register(rest);
    if (auth) this.auth.set(rest.name, auth);
    else this.auth.delete(rest.name);
  }

  authOf(name: string): SessionAuth | null {
    return this.auth.get(name) ?? null;
  }
}

/** The session auth of collection `name` in `registry` (`null` for a plain jsudc registry). */
export function collectionAuth(registry: CollectionRegistry, name: string): SessionAuth | null {
  return registry instanceof MementoRegistry ? registry.authOf(name) : null;
}
