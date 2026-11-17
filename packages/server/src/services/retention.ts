import { and, asc, count, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { type Database, dialect } from "../db/index.js";
import { events, tenants } from "../db/schema.js";
import { MementoError } from "../errors.js";

/** Events archived per UPDATE: keeps each statement (and its row locks) short. */
export const RETENTION_BATCH_SIZE = 10_000;

export interface RetentionOptions {
  /** Only this tenant (its slug). Default: every tenant with `retention_days`. */
  tenant?: string;
  /** Count what would be archived, change nothing. */
  dryRun?: boolean;
  batchSize?: number;
  now?: Date;
}

export interface RetentionResult {
  tenant: string;
  retention_days: number;
  /** Events older than this were archived (or, with `dryRun`, would be). */
  cutoff: string;
  archived: number;
}

/**
 * Archives (sets `archived_at`, the one change the immutability trigger allows) the live
 * events of every tenant with `retention_days` that happened before `now - retention_days`,
 * in batches. Tenants without a value keep everything. Every list and query already skips
 * archived events, so they disappear from the API at once.
 */
export async function applyRetention(
  db: Database,
  options: RetentionOptions = {},
): Promise<RetentionResult[]> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
  const where = options.tenant
    ? eq(tenants.slug, options.tenant)
    : isNotNull(tenants.retentionDays);
  const rows = await db
    .select()
    .from(tenants)
    .where(where)
    .orderBy(asc(dialect.bytewise(tenants.slug)));
  if (options.tenant && rows.length === 0) {
    throw new MementoError("not_found", `tenant "${options.tenant}" not found`);
  }
  const results: RetentionResult[] = [];
  for (const tenant of rows) {
    if (tenant.retentionDays === null) continue;
    const cutoff = new Date(now.getTime() - tenant.retentionDays * 86_400_000);
    const expired = and(
      eq(events.tenantId, tenant.id),
      isNull(events.archivedAt),
      lt(events.occurredAt, cutoff),
    );
    let archived = 0;
    if (options.dryRun) {
      const [row] = await db.select({ n: count() }).from(events).where(expired);
      archived = row?.n ?? 0;
    } else {
      for (;;) {
        const batch = await db
          .update(events)
          .set({ archivedAt: now })
          .where(
            sql`${events.id} in (select ${events.id} from ${events} where ${expired} limit ${batchSize})`,
          )
          .returning({ id: events.id });
        archived += batch.length;
        if (batch.length < batchSize) break;
      }
    }
    results.push({
      tenant: tenant.slug,
      retention_days: tenant.retentionDays,
      cutoff: cutoff.toISOString(),
      archived,
    });
  }
  return results;
}
