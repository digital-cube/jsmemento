import type { Database } from "./db/client.js";
import { MementoError } from "./errors.js";
import { authenticateApiKey } from "./services/apikeys.js";

/** The key the examples site connects with when the visitor has none (`GET /api/demo`). */
export interface DemoKey {
  apiKey: string;
  /** Slug of the key's tenant. */
  tenant: string;
}

/** Why the server refuses to start with a `MEMENTO_DEMO_API_KEY`. */
export class DemoKeyError extends Error {
  constructor(reason: string) {
    super(`MEMENTO_DEMO_API_KEY must be a read-only key: ${reason}`);
    this.name = "DemoKeyError";
  }
}

/**
 * Resolves the demo key as a request would and checks that it may be published: it must
 * exist, be active, and have exactly the `read` scope. The page gets this key without any
 * credentials, so a `write` or `admin` key never leaves the server — startup fails instead.
 */
export async function resolveDemoKey(db: Database, key: string): Promise<DemoKey> {
  let tenant: Awaited<ReturnType<typeof authenticateApiKey>>;
  try {
    tenant = await authenticateApiKey(db, key.trim());
  } catch (error) {
    if (error instanceof MementoError && error.code === "unauthorized") {
      throw new DemoKeyError("it is unknown, revoked or expired, or its tenant is inactive");
    }
    throw error;
  }
  const extra = tenant.scopes.filter((scope) => scope !== "read");
  if (extra.length > 0 || !tenant.scopes.includes("read")) {
    throw new DemoKeyError(
      `it has the scopes ${tenant.scopes.join(",") || "(none)"}; create one with --scopes read`,
    );
  }
  return { apiKey: key.trim(), tenant: tenant.tenantSlug };
}
