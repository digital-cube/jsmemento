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
 *
 * With the chat scene on (the default of `memento simulate`, `--no-chat` turns it off) the
 * same people also talk in one room, `chat-demo-room`, through the chat endpoints
 * (docs/CHATS.md): a member says a line about the tickets of the story, another marks it
 * seen, now and then somebody is added. Those steps are not events the pusher builds but
 * calls the server turns into CHAT_MESSAGE_SENT / CHAT_MESSAGE_SEEN / CHAT_PARTICIPANT_ADDED.
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

/** The one room of the chat scene: a fixed id, so every run talks in the same room. */
export const ROOM_ID = "chat-demo-room";
export const ROOM_NAME = "Demo room";
/** Who the room is created with; the rest of the team is added now and then. */
export const ROOM_FOUNDERS = ["igor", "marko", "ana", "jelena"] as const;

/**
 * What the team says in the room. `{t}` is a ticket of the story: an open one (`open`) or
 * the one closed last (`closed`, `{r}` its resolution). People write in English or Serbian;
 * the lines alternate, and nothing is translated.
 */
export interface ChatLine {
  ticket: "open" | "closed" | null;
  en: string;
  sr: string;
}
export const CHAT_SCRIPT: readonly ChatLine[] = [
  { ticket: "open", en: "I took {t}.", sr: "Uzimam {t}." },
  {
    ticket: "open",
    en: "Can someone look at {t}? The customer is waiting.",
    sr: "Može li neko da pogleda {t}? Klijent čeka.",
  },
  {
    ticket: "open",
    en: "{t} is in review, have a look when you can.",
    sr: "{t} je na review-u, pogledajte kad stignete.",
  },
  {
    ticket: "open",
    en: "Cannot reproduce {t} locally, trying staging.",
    sr: "Ne mogu da reprodukujem {t} lokalno, probam na stagingu.",
  },
  {
    ticket: "open",
    en: "Who is on {t}? Nobody picked it up.",
    sr: "Ko radi na {t}? Niko ga nije uzeo.",
  },
  { ticket: "closed", en: "Closing {t}, {r}.", sr: "Zatvaram {t}, {r}." },
  { ticket: "closed", en: "{t} is finally gone 🎉", sr: "{t} je konačno rešen 🎉" },
  {
    ticket: null,
    en: "Coffee break, back in ten.",
    sr: "Pauza za kafu, vraćam se za deset minuta.",
  },
  { ticket: null, en: "Standup in five minutes.", sr: "Standup za pet minuta." },
  {
    ticket: null,
    en: "Staging is slow again, is it just me?",
    sr: "Staging je opet spor, da li je samo kod mene?",
  },
  { ticket: null, en: "Thanks!", sr: "Hvala!" },
];

/** A step of the chat scene: a call to the chat endpoints, not an event of its own. */
export type ChatStep =
  /** `POST /chats/:id/messages` as `user_id`. */
  | { kind: "message"; user_id: string; content: string }
  /** `POST /chats/:id/seen`: `user_id` read up to the newest message. */
  | { kind: "seen"; user_id: string }
  /** `POST /chats/:id/participants`: `added_by` adds `user_id` to the room. */
  | { kind: "join"; user_id: string; added_by: string };

/** One step of the story: an event to push, or a chat call. */
export type DeskStep = { kind: "event"; event: EventInput } | ChatStep;

export interface TicketDeskOptions {
  /** Play the chat scene too. Default `false`: `next()` then only ever returns events. */
  chat?: boolean;
  /** Who is in the room already (an existing room); default the founders. */
  roomMembers?: Iterable<string>;
}

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
type Scene =
  | "login"
  | "create"
  | "modify"
  | "note"
  | "close"
  | "logout"
  | "newcomer"
  | "stale"
  | "say"
  | "seen"
  | "join";
const CHAT_SCENES: ReadonlySet<Scene> = new Set(["say", "seen", "join"]);
const WEIGHTS: Record<Scene, number> = {
  login: 3,
  create: 3,
  modify: 4,
  note: 3,
  close: 2,
  logout: 1,
  newcomer: 0.4,
  stale: 2,
  say: 3,
  seen: 2,
  join: 0.3,
};

/**
 * The ticket desk: who is logged in, which tickets are open, and (with `chat`) who is in the
 * room. `nextStep(at)` plays one scene; `next(at)` is the same for a desk without the chat
 * scene, as the one event it produced. Deterministic for a seed; without the chat scene the
 * story is exactly the one the desk played before the room existed.
 */
export class TicketDesk {
  /** Steps played so far. */
  step = 0;
  readonly users: string[] = [...CAST];
  readonly online = new Set<string>();
  readonly open = new Map<string, Ticket>();
  /** Members of the room. */
  readonly room: Set<string>;
  /** Messages said in the room in this run. */
  said = 0;
  readonly chat: boolean;
  private lastSender: string | null = null;
  private lastLine: ChatLine | null = null;
  /** How many of this run's messages each member has marked seen. */
  private readonly seenUpTo = new Map<string, number>();
  private lastClosed: { id: string; resolution: string } | null = null;
  private nextTicket = 1;
  private newcomers = 0;
  private readonly random: () => number;

  constructor(
    readonly seed: number,
    options: TicketDeskOptions = {},
  ) {
    this.random = prng(seed);
    this.chat = options.chat ?? false;
    this.room = new Set(options.roomMembers ?? ROOM_FOUNDERS);
  }

  /** One scene, as the event it produced, `occurred_at` = `at` (a desk without `chat`). */
  next(at: Date = new Date()): EventInput {
    const step = this.nextStep(at);
    if (step.kind !== "event") throw new Error("a desk with the chat scene plays nextStep()");
    return step.event;
  }

  /** One scene: the event it produced (`occurred_at` = `at`), or the chat call it makes. */
  nextStep(at: Date = new Date()): DeskStep {
    const scene = this.pick(this.possible());
    this.step += 1;
    if (CHAT_SCENES.has(scene)) return this.talk(scene);
    return { kind: "event", event: { ...this.play(scene), occurred_at: at.toISOString() } };
  }

  /** Online members of the room. */
  private present(): string[] {
    return [...this.online].filter((u) => this.room.has(u));
  }

  /** Who can mark the newest message seen: present, not its sender, not up to date yet. */
  private readers(): string[] {
    return this.present().filter(
      (u) => u !== this.lastSender && (this.seenUpTo.get(u) ?? 0) < this.said,
    );
  }

  private talk(scene: Scene): ChatStep {
    if (scene === "seen") {
      const who = this.any(this.readers());
      this.seenUpTo.set(who, this.said);
      return { kind: "seen", user_id: who };
    }
    if (scene === "join") {
      const by = this.any(this.present());
      const who = this.any(this.users.filter((u) => !this.room.has(u)));
      this.room.add(who);
      return { kind: "join", user_id: who, added_by: by };
    }
    const who = this.any(this.present());
    const line = this.any(
      CHAT_SCRIPT.filter(
        (l) =>
          l !== this.lastLine &&
          (l.ticket === null ||
            (l.ticket === "open" && this.open.size > 0) ||
            (l.ticket === "closed" && this.lastClosed !== null)),
      ),
    );
    // Nobody says the same thing twice in a row (in the other language either).
    this.lastLine = line;
    let content = this.said % 2 === 0 ? line.en : line.sr;
    if (line.ticket === "open") {
      content = content.replace("{t}", this.any([...this.open.keys()]));
    } else if (line.ticket === "closed") {
      const closed = this.lastClosed as { id: string; resolution: string };
      content = content.replace("{t}", closed.id).replace("{r}", closed.resolution);
    }
    this.said += 1;
    this.lastSender = who;
    // Whoever writes has read what came before.
    this.seenUpTo.set(who, this.said);
    return { kind: "message", user_id: who, content };
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
      say: this.chat && this.present().length > 0,
      seen: this.chat && this.said > 0 && this.readers().length > 0,
      join: this.chat && this.present().length > 0 && this.users.some((u) => !this.room.has(u)),
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
    const closed = (t: Ticket, resolution: string) => {
      this.open.delete(t.id);
      this.lastClosed = { id: t.id, resolution };
      return resolution;
    };
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
        return ticket(who, "TICKET_CLOSED", t, { resolution: closed(t, this.any(RESOLUTIONS)) });
      }
      case "stale": {
        const t = this.stale() as Ticket;
        return ticket(BOT, "TICKET_CLOSED", t, { resolution: closed(t, "stale") });
      }
      default:
        throw new Error(`not an event scene: ${scene}`);
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
  /** Play the chat scene in `chat-demo-room` too. Default `true`; `--no-chat` turns it off. */
  chat?: boolean;
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

const isConflict = (error: unknown) => error instanceof MementoApiError && error.status === 409;

/**
 * Makes sure the demo room exists and returns who is in it. Creates it with the founders;
 * when it exists already (`409`), reads its members through `GET /chats?user_id=` — which
 * needs the `read` scope, so a write-only key keeps the founders and learns about anybody
 * else when adding them answers `409` (taken quietly, see `perform`).
 */
export async function ensureRoom(
  client: MementoClient,
): Promise<{ created: boolean; members: string[] }> {
  try {
    const chat = await client.createChat({
      chat_id: ROOM_ID,
      name: ROOM_NAME,
      kind: "room",
      participants: [...ROOM_FOUNDERS],
    });
    return { created: true, members: chat.participants.map((p) => p.user_id) };
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  for (const founder of ROOM_FOUNDERS) {
    try {
      const page = await client.listChats({ user_id: founder, limit: 500 });
      const room = page.data.find((chat) => chat.chat_id === ROOM_ID);
      if (room) return { created: false, members: room.participants.map((p) => p.user_id) };
    } catch (error) {
      // No read scope: nobody can be asked, the founders will do.
      if (error instanceof MementoApiError && error.status === 403) break;
      throw error;
    }
  }
  return { created: false, members: [...ROOM_FOUNDERS] };
}

/**
 * Plays one step against the server: pushes the event, or makes the chat call. Returns the
 * event the server stored, or `null` when the step stored none (a member who was already in
 * the room, a message already seen).
 */
async function perform(
  client: MementoClient,
  step: DeskStep,
  locale: string | undefined,
): Promise<MementoEvent | null> {
  const options = locale ? { locale } : {};
  switch (step.kind) {
    case "event":
      return client.pushEvent(step.event, options);
    case "message":
      return (
        await client.sendMessage(ROOM_ID, { user_id: step.user_id, content: step.content }, options)
      ).message;
    case "seen":
      return (await client.markSeen(ROOM_ID, { user_id: step.user_id }, options)).event;
    case "join":
      try {
        return (
          await client.addParticipant(
            ROOM_ID,
            { user_id: step.user_id, added_by: step.added_by },
            options,
          )
        ).event;
      } catch (error) {
        if (isConflict(error)) return null;
        throw error;
      }
  }
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
  const chat = options.chat ?? true;
  const sleep = deps.sleep ?? abortableSleep;
  const intervalMs = options.interval * 1000;

  if (options.tenant) await checkTenant(client, options.tenant, ui, options.url);

  io.err(
    c.green(
      `● simulate: a ticket desk${chat ? ` and ${ROOM_ID}` : ""} (seed ${seed}), one event every ${options.interval}s to ${options.url}` +
        (options.count ? ` (${options.count} events)` : " (Ctrl+C to stop)"),
    ),
  );
  /** The room's members, once the room is known to exist; retried before the first chat step. */
  let members: string[] | null = null;
  const room = async () => {
    if (members) return members;
    const { created, members: found } = await ensureRoom(client);
    members = found;
    io.err(
      c.green(
        `● ${created ? "created" : "talking in"} ${ROOM_ID} "${ROOM_NAME}": ${found.join(", ")}`,
      ),
    );
    return found;
  };
  let roomMembers: string[] | undefined;
  if (chat) {
    try {
      roomMembers = await room();
    } catch (error) {
      if (isFatal(error)) {
        const e = error as MementoApiError;
        throw new MementoApiError(e.status, e.code, `room refused: ${e.message}`, e.details);
      }
      io.err(c.red(`✗ cannot reach the room yet: ${(error as Error).message} — retrying later`));
    }
  }
  const desk = new TicketDesk(seed, {
    chat,
    ...(roomMembers ? { roomMembers } : {}),
  });

  const summary: SimulateSummary = { seed, pushed: 0, failed: 0 };
  let failing = 0;
  /** The scene that could not be pushed yet: retried before the story moves on. */
  let pending: DeskStep | null = null;
  while (!signal?.aborted) {
    const started = Date.now();
    const step: DeskStep = pending
      ? retimed(pending, new Date(started))
      : desk.nextStep(new Date(started));
    try {
      if (step.kind !== "event") await room();
      const stored = await perform(client, step, options.locale);
      pending = null;
      summary.pushed += 1;
      if (failing > 0) {
        io.err(c.green(`● reconnected after ${failing} failed push(es)`));
        failing = 0;
      }
      if (stored) io.out(json ? JSON.stringify(stored) : storyLine(stored, ui, deps.timeZone));
      else if (!json && step.kind !== "event") {
        io.out(c.dim(`(${step.kind} ${describeStep(step)}: nothing new to store)`));
      }
    } catch (error) {
      if (isFatal(error)) {
        const e = error as MementoApiError;
        throw new MementoApiError(e.status, e.code, `push refused: ${e.message}`, e.details);
      }
      pending = step;
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

/** A step retried later: an event gets the time of the new attempt. */
function retimed(step: DeskStep, at: Date): DeskStep {
  if (step.kind !== "event") return step;
  return { kind: "event", event: { ...step.event, occurred_at: at.toISOString() } };
}

function describeStep(step: ChatStep): string {
  return step.kind === "join" ? `${step.added_by} → ${step.user_id}` : step.user_id;
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
