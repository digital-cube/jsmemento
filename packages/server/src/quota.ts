import { and, eq, gte, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { TenantContext } from "./context.js";
import { type Database, dialect } from "./db/index.js";
import { type ApiKeyRow, apiKeys, apiKeyUsage, tenantUsers, users } from "./db/schema.js";
import { MementoError } from "./errors.js";
import type { Mailer } from "./mail/mailer.js";
import type { MailTemplates } from "./mail/templates.js";
import { dayStartOf, isMetered, type UsageMeter, utcDay } from "./usage.js";

/** Share of the daily limit at which the warning mail goes out. */
export const QUOTA_WARNING_RATIO = 0.8;
/** The Redis counter outlives its day by a day, then expires on its own. */
export const QUOTA_COUNTER_TTL_SECONDS = 172_800;

/** `memento:quota:<api key id>:<YYYY-MM-DD>`: events the key wrote that UTC day. */
export function quotaKey(apiKeyId: string, day: string): string {
  return `memento:quota:${apiKeyId}:${day}`;
}

/** The part of a logger the quota uses. */
export interface QuotaLog {
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface QuotaMailOptions {
  mailer: Mailer;
  templates: MailTemplates;
  /** Public origin of the service site: the key's page in the mail. */
  serviceUrl: string;
}

export interface QuotaGuardOptions {
  db: Database;
  usage: UsageMeter;
  /** Today's counters live here when set; otherwise they are summed from the usage table. */
  redis?: Redis | null;
  /** The limit of a key without its own. */
  defaultDailyLimit: number;
  /**
   * `null` → the 80 % / 100 % mails are not sent and the day's mail is not claimed, so a
   * process that can send it still does (the limit holds either way).
   */
  mail?: QuotaMailOptions | null;
  log: QuotaLog;
  now?: () => Date;
}

/** `kind` of the quota mails: `quota_warning.<locale>.hbs`, `quota_exceeded.<locale>.hbs`. */
export type QuotaMailKind = "quota_warning" | "quota_exceeded";

/**
 * The daily event limit of API keys. `check` runs before a key writes events: past the limit
 * it throws `quota_exceeded` (429), at 80 % it sends the warning — each mail once per UTC day
 * per key, claimed with an atomic `UPDATE … WHERE quota_*_on IS DISTINCT FROM today`.
 * `recorded` counts what was stored. Session writes (`apiKeyId: null`) and keys the auth step
 * left unmetered (`isMetered`) are never limited.
 */
export class QuotaGuard {
  private readonly now: () => Date;

  constructor(private readonly options: QuotaGuardOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The limit `row` writes under. */
  limitOf(row: Pick<ApiKeyRow, "dailyLimit">): number {
    return row.dailyLimit ?? this.options.defaultDailyLimit;
  }

  /** Events `apiKeyId` wrote today (UTC). */
  async usedToday(apiKeyId: string): Promise<number> {
    const now = this.now();
    const { redis } = this.options;
    if (redis) {
      try {
        return Number((await redis.get(quotaKey(apiKeyId, utcDay(now)))) ?? 0);
      } catch (error) {
        this.options.log.warn({ err: error }, "quota counter unavailable in redis; using the DB");
      }
    }
    return this.usedFromTable(apiKeyId, now);
  }

  /** Today's events of several keys at once (the `api_keys` collection). */
  async usedTodayMany(apiKeyIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (apiKeyIds.length === 0) return result;
    const now = this.now();
    const { redis } = this.options;
    if (redis) {
      try {
        const values = await redis.mget(...apiKeyIds.map((id) => quotaKey(id, utcDay(now))));
        apiKeyIds.forEach((id, i) => {
          result.set(id, Number(values[i] ?? 0));
        });
        return result;
      } catch (error) {
        this.options.log.warn({ err: error }, "quota counter unavailable in redis; using the DB");
      }
    }
    const rows = await this.options.db
      .select({
        id: apiKeyUsage.apiKeyId,
        total: sql<string>`coalesce(sum(${apiKeyUsage.eventsWritten}), 0)`,
      })
      .from(apiKeyUsage)
      .where(
        and(
          sql`${apiKeyUsage.apiKeyId} in (${sql.join(
            apiKeyIds.map((id) => dialect.uuid(id)),
            sql`, `,
          )})`,
          gte(apiKeyUsage.hour, dayStartOf(now)),
        ),
      )
      .groupBy(apiKeyUsage.apiKeyId);
    const stored = new Map(rows.map((r) => [r.id, Number(r.total)]));
    for (const id of apiKeyIds) {
      result.set(
        id,
        (stored.get(id) ?? 0) + this.options.usage.pendingEventsWritten(id, dayStartOf(now)),
      );
    }
    return result;
  }

  /**
   * Refuses `incoming` more events past the key's limit (`quota_exceeded`, with
   * `{ limit, used, resets_at }`), and sends the warning / exceeded mail the first time a day.
   */
  async check(context: TenantContext, incoming = 1): Promise<void> {
    if (!context.apiKeyId || !isMetered(context)) return;
    const row = await this.options.db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, context.apiKeyId),
    });
    if (!row) return;
    const limit = this.limitOf(row);
    const used = await this.usedToday(row.id);
    const now = this.now();
    const today = utcDay(now);
    if (used + incoming > limit) {
      if (this.options.mail && (await this.claim(row.id, "quota_exceeded", today))) {
        void this.mail(row, "quota_exceeded", { used, limit, now });
      }
      const resetsAt = new Date(dayStartOf(now).getTime() + 86_400_000).toISOString();
      throw new MementoError(
        "quota_exceeded",
        `this API key wrote its daily limit of ${limit} events; it resets at ${resetsAt}`,
        { limit, used, resets_at: resetsAt },
      );
    }
    if (
      this.options.mail &&
      used + incoming >= QUOTA_WARNING_RATIO * limit &&
      row.quotaWarnedOn !== today
    ) {
      if (await this.claim(row.id, "quota_warning", today)) {
        void this.mail(row, "quota_warning", { used: used + incoming, limit, now });
      }
    }
  }

  /** Counts `count` stored events of the key: today's counter and the usage meter. */
  async recorded(context: TenantContext, count = 1): Promise<void> {
    if (!context.apiKeyId || !isMetered(context) || count <= 0) return;
    this.options.usage.add(context.apiKeyId, context.tenantId, { events_written: count });
    const { redis } = this.options;
    if (!redis) return;
    const key = quotaKey(context.apiKeyId, utcDay(this.now()));
    try {
      await redis.multi().incrby(key, count).expire(key, QUOTA_COUNTER_TTL_SECONDS).exec();
    } catch (error) {
      this.options.log.warn({ err: error }, "could not count the event in redis");
    }
  }

  private async usedFromTable(apiKeyId: string, now: Date): Promise<number> {
    const since = dayStartOf(now);
    const [row] = await this.options.db
      .select({ total: sql<string>`coalesce(sum(${apiKeyUsage.eventsWritten}), 0)` })
      .from(apiKeyUsage)
      .where(and(eq(apiKeyUsage.apiKeyId, apiKeyId), gte(apiKeyUsage.hour, since)));
    return Number(row?.total ?? 0) + this.options.usage.pendingEventsWritten(apiKeyId, since);
  }

  /** Marks today's mail of `kind` as sent; `false` when it already was (by any process). */
  private async claim(apiKeyId: string, kind: QuotaMailKind, today: string): Promise<boolean> {
    const column = kind === "quota_warning" ? apiKeys.quotaWarnedOn : apiKeys.quotaExceededOn;
    const set = kind === "quota_warning" ? { quotaWarnedOn: today } : { quotaExceededOn: today };
    const claimed = await this.options.db
      .update(apiKeys)
      .set(set)
      .where(and(eq(apiKeys.id, apiKeyId), dialect.isDistinctFrom(column, dialect.date(today))))
      .returning({ id: apiKeys.id });
    return claimed.length > 0;
  }

  /** Fire-and-forget: a mail that cannot be sent is logged, never thrown. */
  private async mail(
    row: ApiKeyRow,
    kind: QuotaMailKind,
    { used, limit, now }: { used: number; limit: number; now: Date },
  ): Promise<void> {
    const mail = this.options.mail;
    if (!mail) return;
    try {
      const to = await recipientOf(this.options.db, row);
      if (!to) return;
      const resetsAt = new Date(dayStartOf(now).getTime() + 86_400_000).toISOString();
      const message = mail.templates.render(kind, to.locale, {
        name: to.name,
        key_name: row.name,
        prefix: row.prefix,
        used,
        limit,
        resets_at: resetsAt,
        link: `${mail.serviceUrl}/keys/${row.id}`,
        service_url: mail.serviceUrl,
      });
      await mail.mailer.send({ to: to.email, ...message });
    } catch (error) {
      this.options.log.error({ err: error, kind, api_key: row.id }, "could not send a quota mail");
    }
  }
}

/** Who hears about a key: the user who created it, else the owner of its tenant. */
export async function recipientOf(
  db: Database,
  row: Pick<ApiKeyRow, "createdBy" | "tenantId">,
): Promise<{ email: string; name: string; locale: string } | null> {
  const columns = { email: users.email, name: users.name, locale: users.locale };
  if (row.createdBy) {
    const [creator] = await db.select(columns).from(users).where(eq(users.id, row.createdBy));
    if (creator) return creator;
  }
  const [owner] = await db
    .select(columns)
    .from(tenantUsers)
    .innerJoin(users, eq(tenantUsers.userId, users.id))
    .where(and(eq(tenantUsers.tenantId, row.tenantId), eq(tenantUsers.role, "owner")))
    .limit(1);
  return owner ?? null;
}
