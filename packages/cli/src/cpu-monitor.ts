import { hostname, loadavg } from "node:os";
import { type EventInput, MementoApiError, MementoClient, type MementoEvent } from "@memento/core";
import type { CliIO } from "./program.js";
import { clock } from "./tail.js";
import type { Ui } from "./ui.js";

export const CPU_LOAD_EVENT_TYPE = "CPU_LOAD";

export interface CpuMonitorOptions {
  url: string;
  apiKey?: string;
  /** Seconds between two samples. */
  interval: number;
  /** When set, the key must belong to this tenant (checked once, through `/describe`). */
  tenant?: string;
  instanceType: string;
  /** Default: the host name. */
  instanceId?: string;
  actor: string;
  locale?: string;
  /** Stop after this many samples (pushed or failed); default: run until interrupted. */
  count?: number;
}

export interface CpuMonitorDeps {
  io: CliIO;
  ui: Ui;
  json: boolean;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  /** `[1, 5, 15]`-minute load averages. Default `os.loadavg`. */
  loadavg?: () => number[];
  hostname?: () => string;
  /** Resolves after `ms`, or as soon as `signal` aborts. Default: a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeZone?: string | undefined;
}

export interface CpuMonitorSummary {
  pushed: number;
  failed: number;
}

/** A usage or fatal problem of `cpu-monitor` (reported like a domain error, exit 1). */
export class CpuMonitorError extends Error {
  override readonly name = "CpuMonitorError";
}

/** Load averages rounded to two decimals, as `payload` of a `CPU_LOAD` event. */
export function cpuPayload(load: readonly number[]): Record<string, number> {
  const round = (n: number | undefined) => Math.round((n ?? 0) * 100) / 100;
  return { load_1min: round(load[0]), load_5min: round(load[1]), load_15min: round(load[2]) };
}

/** The event one sample becomes. */
export function cpuEvent(
  options: Pick<CpuMonitorOptions, "instanceType" | "actor"> & { instanceId: string },
  load: readonly number[],
  at: Date,
): EventInput {
  return {
    event_type: CPU_LOAD_EVENT_TYPE,
    instance_type: options.instanceType,
    instance_id: options.instanceId,
    actor_id: options.actor,
    occurred_at: at.toISOString(),
    payload: cpuPayload(load),
  };
}

/** Errors that will not go away by trying again: a bad key, a missing scope, a bad event. */
export function isFatal(error: unknown): boolean {
  return error instanceof MementoApiError && error.status >= 400 && error.status < 500;
}

/** Resolves after `ms`, or at once when `signal` aborts (also used by `simulate`). */
export const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * `memento cpu-monitor`: every `interval` seconds reads the load averages and pushes them as
 * a `CPU_LOAD` event. A network or server failure is logged and the next sample tried; a
 * refusal (bad key, missing scope, invalid event) stops it. Returns when `signal` aborts or
 * after `count` samples.
 */
export async function runCpuMonitor(
  options: CpuMonitorOptions,
  deps: CpuMonitorDeps,
): Promise<CpuMonitorSummary> {
  const { io, ui, json, signal } = deps;
  const { c } = ui;
  if (!options.apiKey) {
    throw new CpuMonitorError("no API key: pass --key or set MEMENTO_API_KEY (scope write)");
  }
  if (!Number.isFinite(options.interval) || options.interval <= 0) {
    throw new CpuMonitorError("--interval must be a positive number of seconds");
  }
  const client = new MementoClient({
    baseUrl: options.url,
    apiKey: options.apiKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const instanceId = options.instanceId ?? (deps.hostname ?? hostname)();
  const read = deps.loadavg ?? loadavg;
  const sleep = deps.sleep ?? abortableSleep;
  const intervalMs = options.interval * 1000;

  if (options.tenant) await checkTenant(client, options.tenant, ui, options.url);

  const where = `${options.instanceType}/${instanceId}`;
  io.err(
    c.green(
      `● cpu-monitor: pushing ${CPU_LOAD_EVENT_TYPE} for ${where} every ${options.interval}s to ${options.url}` +
        (options.count ? ` (${options.count} samples)` : " (Ctrl+C to stop)"),
    ),
  );
  const summary: CpuMonitorSummary = { pushed: 0, failed: 0 };
  /** Failed pushes since the last one that went through. */
  let failing = 0;
  while (!signal?.aborted) {
    const started = Date.now();
    const event = cpuEvent({ ...options, instanceId }, read(), new Date(started));
    try {
      const stored = await client.pushEvent(
        event,
        options.locale ? { locale: options.locale } : {},
      );
      summary.pushed += 1;
      if (failing > 0) {
        io.err(c.green(`● reconnected after ${failing} failed push(es)`));
        failing = 0;
      }
      io.out(json ? JSON.stringify(stored) : sampleLine(stored, ui, deps.timeZone));
    } catch (error) {
      if (isFatal(error)) {
        const e = error as MementoApiError;
        throw new MementoApiError(e.status, e.code, `push refused: ${e.message}`, e.details);
      }
      summary.failed += 1;
      failing += 1;
      io.err(c.red(`✗ push failed: ${(error as Error).message} — retrying`));
    }
    if (options.count !== undefined && summary.pushed + summary.failed >= options.count) break;
    await sleep(Math.max(0, intervalMs - (Date.now() - started)), signal);
  }
  io.err(c.dim(`cpu-monitor stopped: ${summary.pushed} pushed, ${summary.failed} failed`));
  return summary;
}

/** Fails unless the key belongs to `tenant` (a write-only key cannot tell: not checked). */
export async function checkTenant(
  client: MementoClient,
  tenant: string,
  ui: Ui,
  url: string,
): Promise<void> {
  try {
    const describe = await ui.step(`Connecting to ${url}`, () => client.describe());
    if (describe.tenant.slug !== tenant) {
      throw new CpuMonitorError(
        `this API key belongs to tenant "${describe.tenant.slug}", not "${tenant}"`,
      );
    }
  } catch (error) {
    // A write-only key cannot read /describe: the tenant is then not checked.
    if (error instanceof MementoApiError && error.code === "forbidden") return;
    throw error;
  }
}

/** `[10:00:00] server/backend-01  load 0.52 0.41 0.30  → 1f0c…` */
export function sampleLine(event: MementoEvent, ui: Ui, timeZone?: string): string {
  const { c } = ui;
  const p = event.payload as Record<string, number>;
  const n = (v: number | undefined) => (typeof v === "number" ? v.toFixed(2) : "-");
  return [
    c.dim(`[${clock(event.occurred_at, timeZone)}]`),
    c.cyan(`${event.instance_type}/${event.instance_id}`),
    `load ${c.bold(n(p.load_1min))} ${n(p.load_5min)} ${n(p.load_15min)}`,
    c.dim(`→ ${event.id}`),
  ].join("  ");
}
