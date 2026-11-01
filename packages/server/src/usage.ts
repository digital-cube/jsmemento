import { sql } from "drizzle-orm";
import type { Database } from "./db/client.js";
import { apiKeyUsage } from "./db/schema.js";

/** The counters of `memento_apikey_usage`, as the meter takes them. */
export interface UsageCounters {
  requests?: number;
  events_written?: number;
  rows_read?: number;
  stream_seconds?: number;
  bytes_in?: number;
}

/** One `(key, hour)` row of buffered counters. */
export interface UsageRow {
  apiKeyId: string;
  tenantId: string;
  /** Truncated to the hour, UTC. */
  hour: Date;
  requests: number;
  eventsWritten: number;
  rowsRead: number;
  streamSeconds: number;
  bytesIn: number;
}

/** The part of a logger the meter uses. */
export interface UsageLog {
  error(obj: object, msg?: string): void;
}

export interface UsageMeterOptions {
  db: Database;
  log: UsageLog;
  /** How often the buffer is written. Default 5 000 ms. */
  flushIntervalMs?: number;
  /** The clock rows are bucketed by (tests pin it). */
  now?: () => Date;
  /** Writes one batch; default an `INSERT … ON CONFLICT DO UPDATE` into the usage table. */
  write?: (rows: UsageRow[]) => Promise<void>;
}

export const USAGE_FLUSH_INTERVAL_MS = 5_000;
const HOUR_MS = 3_600_000;

/** `at` cut to the hour (UTC). */
export function hourOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** Midnight (UTC) that starts the day of `at`. */
export function dayStartOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** `YYYY-MM-DD` of `at`'s UTC day. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Upserts a batch: counters already in the table are added to, not replaced. */
export async function writeUsage(db: Database, rows: UsageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const added = (column: string) =>
    sql`${apiKeyUsage}.${sql.identifier(column)} + excluded.${sql.identifier(column)}`;
  await db
    .insert(apiKeyUsage)
    .values(rows)
    .onConflictDoUpdate({
      target: [apiKeyUsage.apiKeyId, apiKeyUsage.hour],
      set: {
        requests: added("requests"),
        eventsWritten: added("events_written"),
        rowsRead: added("rows_read"),
        streamSeconds: added("stream_seconds"),
        bytesIn: added("bytes_in"),
      } as never,
    });
}

/**
 * What every API key does, counted per hour in memory and written to
 * `memento_apikey_usage` every few seconds (and on close) — one upsert per batch, never one
 * per request. A failed write is logged and its counts dropped: metering never fails, or
 * slows down, the request it counts.
 */
export class UsageMeter {
  private buffer = new Map<string, UsageRow>();
  /** The batch being written: still counted by `pendingEventsWritten` until it is stored. */
  private inflight: UsageRow[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => Date;
  private readonly write: (rows: UsageRow[]) => Promise<void>;
  private closed = false;

  constructor(private readonly options: UsageMeterOptions) {
    this.now = options.now ?? (() => new Date());
    this.write = options.write ?? ((rows) => writeUsage(options.db, rows));
    this.timer = setInterval(
      () => void this.flush(),
      options.flushIntervalMs ?? USAGE_FLUSH_INTERVAL_MS,
    );
    this.timer.unref();
  }

  /** Adds `counters` to the key's row of the current hour. Never throws. */
  add(apiKeyId: string, tenantId: string, counters: UsageCounters): void {
    const hour = hourOf(this.now());
    const id = `${apiKeyId}|${hour.getTime()}`;
    let row = this.buffer.get(id);
    if (!row) {
      row = {
        apiKeyId,
        tenantId,
        hour,
        requests: 0,
        eventsWritten: 0,
        rowsRead: 0,
        streamSeconds: 0,
        bytesIn: 0,
      };
      this.buffer.set(id, row);
    }
    row.requests += whole(counters.requests);
    row.eventsWritten += whole(counters.events_written);
    row.rowsRead += whole(counters.rows_read);
    row.streamSeconds += whole(counters.stream_seconds);
    row.bytesIn += whole(counters.bytes_in);
  }

  /** Events of `apiKeyId` counted since `since` that are not in the table yet. */
  pendingEventsWritten(apiKeyId: string, since: Date): number {
    let total = 0;
    for (const row of [...this.buffer.values(), ...this.inflight]) {
      if (row.apiKeyId === apiKeyId && row.hour >= hourOf(since)) total += row.eventsWritten;
    }
    return total;
  }

  /** Rows waiting for the next flush (tests, diagnostics). */
  pending(): UsageRow[] {
    return [...this.buffer.values()];
  }

  /** Writes what is buffered. Resolves once written (or dropped after an error). */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce());
    return this.flushing;
  }

  /** Stops the timer and writes the rest (the plugin's `preClose`). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.size === 0) return;
    const rows = [...this.buffer.values()].filter(
      (r) => r.requests || r.eventsWritten || r.rowsRead || r.streamSeconds || r.bytesIn,
    );
    this.buffer = new Map();
    if (rows.length === 0) return;
    this.inflight = rows;
    try {
      await this.write(rows);
    } catch (error) {
      this.options.log.error({ err: error, rows: rows.length }, "could not write API key usage");
    } finally {
      this.inflight = [];
    }
  }
}

function whole(value: number | undefined): number {
  return value && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
