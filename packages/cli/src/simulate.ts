import { type EventInput, MementoApiError, MementoClient, type MementoEvent } from "@memento/core";
import { abortableSleep, checkTenant, isFatal } from "./cpu-monitor.js";
import type { CliIO } from "./program.js";
import { clock } from "./tail.js";
import type { Ui } from "./ui.js";

/*
 * `memento simulate`: a small team working a ticket desk, one event per step, so a tenant
 * has events people can read (and the examples site something to show besides CPU_LOAD).
 *
 * Every payload carries exactly the fields the bundled templates read
 * (packages/server/templates/*.hbs, docs/TEMPLATES.md), so each event renders with its own
 * template and never with `_generic`:
 *
 *   USER_LOGIN       ip                     USER_CREATED     name, username
 *   USER_LOGOUT      —                      TICKET_CREATED   title (+ priority)
 *   TICKET_MODIFIED  changes {field: {from, to}}            TICKET_CLOSED   resolution
 *   NOTE             text (free text, stored verbatim)
 *
 * plus `actor_type` (`user` or `bot`), which the server checks against the lookups.
 */

/** The team the story starts with: `user/<name>` instances and `actor_id`s. */
export const CAST = ["igor", "marko", "ana", "jelena", "nikola", "mila"] as const;
/** People who join later, one `USER_CREATED` each, in this order. */
export const NEWCOMERS = [
  { username: "stefan", name: "Stefan Ilić" },
  { username: "sara", name: "Sara Petrović" },
  { username: "luka", name: "Luka Jovanović" },
  { username: "tea", name: "Tea Marković" },
] as const;
/** The bot that closes tickets nobody touched for `STALE_STEPS` steps. */
export const BOT = "desk-bot";
export const STALE_STEPS = 14;
/** At most this many tickets open at once. */
export const MAX_OPEN = 7;

const TITLES = [
  "Login page returns 500 after password reset",
  "CSV export drops the last row",
  "Dark mode: table header is unreadable",
  "Invoice PDF shows the wrong VAT rate",
  "Search ignores Serbian diacritics",
  "Mobile menu does not close after a tap",
  "Slow dashboard for tenants with 10k events",
  "Typo on the pricing page",
  "Webhook retries never stop",
  "Date picker starts the week on Sunday",
  "Avatar upload fails for PNG over 2 MB",
  "Session expires while typing a long comment",
  "Duplicate e-mail on every ticket update",
  "Timezone shown as UTC in reports",
  "Keyboard shortcut ? opens two dialogs",
  "API docs link to a removed endpoint",
] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const STATUSES = ["open", "in_progress", "waiting", "review"] as const;
const NOTES = [
  "Reproduced on staging, looking into it.",
  "Waiting for the customer's logs.",
  "Same root cause as last week's incident.",
  "Workaround sent to the customer.",
  "Needs a decision from product.",
  "Fix is in review.",
  "Could not reproduce with the latest build.",
  "Added a test that fails without the fix.",
  "Pinged the on-call engineer.",
  "Deployed to staging, please verify.",
] as const;
const RESOLUTIONS = ["fixed", "duplicate", "won't fix", "works as designed", "cannot reproduce"];

/** Deterministic 32-bit PRNG (mulberry32): the same seed, the same story. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed for a run without `--seed`. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

interface Ticket {
  id: string;
  title: string;
  priority: (typeof PRIORITIES)[number];
  status: (typeof STATUSES)[number];
  assignee: string | null;
  /** The step it was last created, modified or noted at. */
  touched: number;
}

/** The scenes, with how often each is picked when it can happen. */
type Scene = "login" | "create" | "modify" | "note" | "close" | "logout" | "newcomer" | "stale";
const WEIGHTS: Record<Scene, number> = {
  login: 3,
  create: 3,
  modify: 4,
  note: 3,
  close: 2,
  logout: 1,
  newcomer: 0.4,
  stale: 2,
};

/**
 * The ticket desk: who is logged in, which tickets are open. `next(at)` plays one scene and
 * returns the one event it produced. Deterministic for a seed.
 */
export class TicketDesk {
  /** Steps played so far. */
  step = 0;
  readonly users: string[] = [...CAST];
  readonly online = new Set<string>();
  readonly open = new Map<string, Ticket>();
  private nextTicket = 1;
  private newcomers = 0;
  private readonly random: () => number;

  constructor(readonly seed: number) {
    this.random = prng(seed);
  }

  /** One scene, as the event it produced, `occurred_at` = `at`. */
  next(at: Date = new Date()): EventInput {
    const scene = this.pick(this.possible());
    this.step += 1;
    return { ...this.play(scene), occurred_at: at.toISOString() };
  }

  /** Every scene that can happen now, with its weight. */
  private possible(): [Scene, number][] {
    const offline = this.users.some((u) => !this.online.has(u));
    const someone = this.online.size > 0;
    const tickets = this.open.size > 0;
    const can: Record<Scene, boolean> = {
      login: offline,
      create: someone && this.open.size < MAX_OPEN,
      modify: someone && tickets,
      note: someone && tickets,
      close: someone && tickets,
      logout: this.online.size > 1,
      newcomer: someone && this.newcomers < NEWCOMERS.length,
      stale: this.stale() !== undefined,
    };
    return (Object.keys(WEIGHTS) as Scene[])
      .filter((s) => can[s])
      .map((s) => [s, WEIGHTS[s] * (s === "login" && !someone ? 10 : 1)]);
  }

  private pick(scenes: [Scene, number][]): Scene {
    let roll = this.random() * scenes.reduce((sum, [, w]) => sum + w, 0);
    for (const [scene, weight] of scenes) {
      roll -= weight;
      if (roll < 0) return scene;
    }
    return (scenes.at(-1) as [Scene, number])[0];
  }

  private any<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)] as T;
  }

  private stale(): Ticket | undefined {
    return [...this.open.values()].find((t) => this.step - t.touched >= STALE_STEPS);
  }

  private play(scene: Scene): Omit<EventInput, "occurred_at"> {
    const user = (actor: string, event_type: string, instance: string, payload = {}) => ({
      event_type,
      instance_type: "user",
      instance_id: instance,
      actor_id: actor,
      payload: { ...payload, actor_type: "user" },
    });
    const ticket = (actor: string, event_type: string, t: Ticket, payload: object) => ({
      event_type,
      instance_type: "ticket",
      instance_id: t.id,
      actor_id: actor,
      payload: { ...payload, actor_type: actor === BOT ? "bot" : "user" },
    });
    switch (scene) {
      case "login": {
        const who = this.any(this.users.filter((u) => !this.online.has(u)));
        this.online.add(who);
        return user(who, "USER_LOGIN", who, { ip: this.ip(who) });
      }
      case "logout": {
        const who = this.any([...this.online]);
        this.online.delete(who);
        return user(who, "USER_LOGOUT", who);
      }
      case "newcomer": {
        const admin = this.any([...this.online]);
        const { username, name } = NEWCOMERS[this.newcomers] as (typeof NEWCOMERS)[number];
        this.newcomers += 1;
        this.users.push(username);
        return user(admin, "USER_CREATED", username, { name, username });
      }
      case "create": {
        const who = this.any([...this.online]);
        const t: Ticket = {
          id: `T-${this.nextTicket++}`,
          title: this.any(TITLES),
          priority: this.any(PRIORITIES),
          status: "open",
          assignee: null,
          touched: this.step,
        };
        this.open.set(t.id, t);
        return ticket(who, "TICKET_CREATED", t, { title: t.title, priority: t.priority });
      }
      case "modify": {
        const who = this.any([...this.online]);
        const t = this.any([...this.open.values()]);
        t.touched = this.step;
        return ticket(who, "TICKET_MODIFIED", t, { changes: this.change(t, who) });
      }
      case "note": {
        const who = this.any([...this.online]);
        const t = this.any([...this.open.values()]);
        t.touched = this.step;
        return ticket(who, "NOTE", t, { text: this.any(NOTES) });
      }
      case "close": {
        const who = this.any([...this.online]);
        const t = this.any([...this.open.values()]);
        this.open.delete(t.id);
        return ticket(who, "TICKET_CLOSED", t, { resolution: this.any(RESOLUTIONS) });
      }
      case "stale": {
        const t = this.stale() as Ticket;
        this.open.delete(t.id);
        return ticket(BOT, "TICKET_CLOSED", t, { resolution: "stale" });
      }
    }
  }

  /** One or two fields of `t` changed, as `{field: {from, to}}` (the template lists the keys). */
  private change(t: Ticket, who: string): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const fields = ["status", "priority", "assignee"] as const;
    const count = this.random() < 0.3 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const field = this.any(fields);
      if (field === "status") {
        const to = this.any(STATUSES.filter((s) => s !== t.status));
        changes.status = { from: t.status, to };
        t.status = to;
      } else if (field === "priority") {
        const to = this.any(PRIORITIES.filter((p) => p !== t.priority));
        changes.priority = { from: t.priority, to };
        t.priority = to;
      } else {
        const to = this.any(this.users.filter((u) => u !== t.assignee && u !== who)) ?? who;
        changes.assignee = { from: t.assignee, to };
        t.assignee = to;
      }
    }
    return changes;
  }

  /** The address a user always logs in from: stable per user. */
  private ip(who: string): string {
    const n = [...who].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 250, 7);
    return `10.0.${(n % 16) + 1}.${n + 2}`;
  }
}

export interface SimulateOptions {
  url: string;
  apiKey?: string;
  /** Seconds between two events. */
  interval: number;
  /** Default: random (printed, so the run can be repeated). */
  seed?: number;
  /** When set, the key must belong to this tenant (checked once, through `/describe`). */
  tenant?: string;
  locale?: string;
  /** Stop after this many steps (pushed or failed); `--once` is 1. Default: run until stopped. */
  count?: number;
}

export interface SimulateDeps {
  io: CliIO;
  ui: Ui;
  json: boolean;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  timeZone?: string | undefined;
}

export interface SimulateSummary {
  seed: number;
  pushed: number;
  failed: number;
}

/** A usage problem of `simulate` (reported like a domain error, exit 1). */
export class SimulateError extends Error {
  override readonly name = "SimulateError";
}

/**
 * `memento simulate`: every `interval` seconds plays one scene of the ticket desk and pushes
 * its event. A network or server failure is logged and the next step tried (the scene is
 * kept, so the story stays whole); a refusal (bad key, missing scope) stops it.
 */
export async function runSimulate(
  options: SimulateOptions,
  deps: SimulateDeps,
): Promise<SimulateSummary> {
  const { io, ui, json, signal } = deps;
  const { c } = ui;
  if (!options.apiKey) {
    throw new SimulateError("no API key: pass --key or set MEMENTO_API_KEY (scope write)");
  }
  if (!Number.isFinite(options.interval) || options.interval <= 0) {
    throw new SimulateError("--interval must be a positive number of seconds");
  }
  const client = new MementoClient({
    baseUrl: options.url,
    apiKey: options.apiKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const seed = options.seed ?? randomSeed();
  const desk = new TicketDesk(seed);
  const sleep = deps.sleep ?? abortableSleep;
  const intervalMs = options.interval * 1000;

  if (options.tenant) await checkTenant(client, options.tenant, ui, options.url);

  io.err(
    c.green(
      `● simulate: a ticket desk (seed ${seed}), one event every ${options.interval}s to ${options.url}` +
        (options.count ? ` (${options.count} events)` : " (Ctrl+C to stop)"),
    ),
  );
  const summary: SimulateSummary = { seed, pushed: 0, failed: 0 };
  let failing = 0;
  /** The scene that could not be pushed yet: retried before the story moves on. */
  let pending: EventInput | null = null;
  while (!signal?.aborted) {
    const started = Date.now();
    const event: EventInput = pending
      ? { ...pending, occurred_at: new Date(started).toISOString() }
      : desk.next(new Date(started));
    try {
      const stored = await client.pushEvent(
        event,
        options.locale ? { locale: options.locale } : {},
      );
      pending = null;
      summary.pushed += 1;
      if (failing > 0) {
        io.err(c.green(`● reconnected after ${failing} failed push(es)`));
        failing = 0;
      }
      io.out(json ? JSON.stringify(stored) : storyLine(stored, ui, deps.timeZone));
    } catch (error) {
      if (isFatal(error)) {
        const e = error as MementoApiError;
        throw new MementoApiError(e.status, e.code, `push refused: ${e.message}`, e.details);
      }
      pending = event;
      summary.failed += 1;
      failing += 1;
      io.err(c.red(`✗ push failed: ${(error as Error).message} — retrying`));
    }
    if (options.count !== undefined && summary.pushed + summary.failed >= options.count) break;
    await sleep(Math.max(0, intervalMs - (Date.now() - started)), signal);
  }
  io.err(c.dim(`simulate stopped: ${summary.pushed} pushed, ${summary.failed} failed`));
  return summary;
}

/** `[10:00:00] TICKET_CREATED   ticket/T-3  igor created ticket T-3: "…".  → 1f0c…` */
export function storyLine(event: MementoEvent, ui: Ui, timeZone?: string): string {
  const { c } = ui;
  return [
    c.dim(`[${clock(event.occurred_at, timeZone)}]`),
    event.event_type.padEnd(15),
    c.cyan(`${event.instance_type}/${event.instance_id}`),
    event.rendered ?? "",
    c.dim(`→ ${event.id}`),
  ].join("  ");
}
