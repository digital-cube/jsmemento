import type { AddressInfo } from "node:net";
import {
  ACTOR_TYPES,
  EVENT_TYPES,
  EventInputSchema,
  FREE_TEXT_EVENT_TYPES,
  INSTANCE_TYPES,
  MementoClient,
} from "@memento/core";
import { LookupRegistry } from "@memento/lookups";
import {
  BUNDLED_TEMPLATES_DIR,
  buildApp,
  connect,
  createApiKey,
  createTenant,
  loadConfig,
  loadTemplateDir,
  TemplateEngine,
} from "@memento/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOT,
  CAST,
  CHAT_SCRIPT,
  type ChatStep,
  type DeskStep,
  ensureRoom,
  MAX_OPEN,
  makeUi,
  NEWCOMERS,
  prng,
  ROOM_FOUNDERS,
  ROOM_ID,
  runCli,
  runSimulate,
  storyLine,
  TicketDesk,
} from "../src/index.js";

const at = new Date("2026-10-31T10:00:00Z");
const story = (seed: number, steps: number) => {
  const desk = new TicketDesk(seed);
  return Array.from({ length: steps }, (_, i) => desk.next(new Date(at.getTime() + i * 1000)));
};

describe("the ticket desk story", () => {
  it("is deterministic for a seed", () => {
    expect(story(42, 200)).toEqual(story(42, 200));
    expect(story(42, 50)).not.toEqual(story(43, 50));
    const random = prng(7);
    const values = Array.from({ length: 1000 }, random);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBe(1000);
  });

  it("produces only events the lookups know, valid on the wire", () => {
    for (const seed of [1, 2, 3]) {
      for (const event of story(seed, 500)) {
        expect(EventInputSchema.safeParse(event).success).toBe(true);
        expect(EVENT_TYPES).toContain(event.event_type);
        expect(INSTANCE_TYPES).toContain(event.instance_type);
        expect(ACTOR_TYPES).toContain((event.payload as { actor_type: string }).actor_type);
        expect(event.event_type).not.toBe("CPU_LOAD");
      }
    }
  });

  it("plays every scene of the cast over 500 steps", () => {
    for (const seed of [1, 2, 3, 42, 2026]) {
      const events = story(seed, 500);
      const types = new Set(events.map((e) => e.event_type));
      expect([...types].sort()).toEqual(
        [
          "NOTE",
          "TICKET_CLOSED",
          "TICKET_CREATED",
          "TICKET_MODIFIED",
          "USER_CREATED",
          "USER_LOGIN",
          "USER_LOGOUT",
        ].sort(),
      );
      const actors = new Set(events.map((e) => e.actor_id));
      for (const name of CAST) expect(actors).toContain(name);
      // The bot closes stale tickets, as an actor of type bot.
      const bot = events.filter((e) => e.actor_id === BOT);
      expect(bot.length).toBeGreaterThan(0);
      expect(bot.every((e) => e.event_type === "TICKET_CLOSED")).toBe(true);
      expect(bot.every((e) => (e.payload as { actor_type: string }).actor_type === "bot")).toBe(
        true,
      );
    }
  });

  it("keeps the story consistent: logins before actions, tickets created before use", () => {
    const desk = new TicketDesk(9);
    const online = new Set<string>();
    const known = new Set<string>(CAST);
    const open = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const e = desk.next(at);
      const actor = e.actor_id as string;
      if (e.event_type === "USER_LOGIN") {
        expect(online.has(actor)).toBe(false);
        expect(known.has(actor)).toBe(true);
        online.add(actor);
        continue;
      }
      if (actor !== BOT) expect(online.has(actor)).toBe(true);
      if (e.event_type === "USER_LOGOUT") online.delete(actor);
      if (e.event_type === "USER_CREATED") {
        expect(known.has(String(e.instance_id))).toBe(false);
        known.add(String(e.instance_id));
      }
      if (e.instance_type === "ticket") {
        expect(e.instance_id).toMatch(/^T-\d+$/);
        if (e.event_type === "TICKET_CREATED") open.add(String(e.instance_id));
        else expect(open.has(String(e.instance_id))).toBe(true);
        if (e.event_type === "TICKET_CLOSED") open.delete(String(e.instance_id));
      }
      expect(open.size).toBeLessThanOrEqual(MAX_OPEN);
    }
  });

  it("renders every event with its own bundled template, in en and sr, never _generic", () => {
    const bundled = loadTemplateDir(BUNDLED_TEMPLATES_DIR);
    const engine = new TemplateEngine({ registry: new LookupRegistry() });
    for (const event of story(5, 500)) {
      const payload = event.payload as Record<string, unknown>;
      if (FREE_TEXT_EVENT_TYPES.includes(event.event_type)) {
        expect(typeof payload.text).toBe("string");
        continue;
      }
      for (const locale of ["en", "sr"]) {
        const body = bundled.get(`${event.event_type}.${locale}`);
        expect(body, `${event.event_type}.${locale}`).toBeDefined();
        const text = engine.render(
          body as string,
          {
            event: { ...event },
            payload,
            event_type: event.event_type,
            instance_type: event.instance_type,
            instance_id: String(event.instance_id),
            actor_id: event.actor_id == null ? null : String(event.actor_id),
            occurred_at: event.occurred_at as string,
          },
          [locale, "en"],
        );
        // What the template reads is there: no empty "()" or missing pieces.
        if (payload.title) expect(text).toContain(String(payload.title));
        if (payload.ip) expect(text).toContain(String(payload.ip));
        if (payload.resolution) expect(text).toContain(String(payload.resolution));
        if (payload.name) expect(text).toContain(String(payload.name));
        if (payload.changes) {
          for (const field of Object.keys(payload.changes)) expect(text).toContain(field);
        }
      }
    }
  });
});

const chatStory = (seed: number, steps: number, roomMembers?: string[]) => {
  const desk = new TicketDesk(seed, { chat: true, ...(roomMembers ? { roomMembers } : {}) });
  const played: { step: DeskStep; online: Set<string>; open: string[] }[] = [];
  for (let i = 0; i < steps; i++) {
    // What the desk knew before the step: who was online, which tickets were open.
    const online = new Set(desk.online);
    const open = [...desk.open.keys()];
    played.push({ step: desk.nextStep(new Date(at.getTime() + i * 1000)), online, open });
  }
  return { desk, played };
};

describe("the chat scene", () => {
  it("is off by default: a desk without it plays exactly the old story", () => {
    const plain = new TicketDesk(42);
    expect(plain.chat).toBe(false);
    for (let i = 0; i < 300; i++) expect(plain.nextStep(at).kind).toBe("event");
    expect(() => new TicketDesk(1, { chat: true }).next(at)).not.toThrow();
  });

  it("is deterministic for a seed and plays every chat step", () => {
    const a = chatStory(7, 400).played.map((p) => p.step);
    expect(a).toEqual(chatStory(7, 400).played.map((p) => p.step));
    for (const seed of [1, 2, 3, 42, 2026]) {
      const kinds = new Set(chatStory(seed, 500).played.map((p) => p.step.kind));
      expect([...kinds].sort()).toEqual(["event", "join", "message", "seen"]);
    }
  });

  it("lets only present members talk and read, and adds only people who are not in yet", () => {
    for (const seed of [1, 5, 9, 2026]) {
      const room = new Set<string>(ROOM_FOUNDERS);
      const known = new Set<string>(CAST);
      let lastSender: string | null = null;
      let said = 0;
      for (const { step, online } of chatStory(seed, 600).played) {
        if (step.kind === "event") {
          if (step.event.event_type === "USER_CREATED") known.add(String(step.event.instance_id));
          continue;
        }
        if (step.kind === "join") {
          expect(room.has(step.added_by)).toBe(true);
          expect(online.has(step.added_by)).toBe(true);
          expect(room.has(step.user_id)).toBe(false);
          expect(known.has(step.user_id)).toBe(true);
          room.add(step.user_id);
          continue;
        }
        expect(room.has(step.user_id), `${step.kind} by ${step.user_id}`).toBe(true);
        expect(online.has(step.user_id)).toBe(true);
        if (step.kind === "seen") {
          expect(said).toBeGreaterThan(0);
          expect(step.user_id).not.toBe(lastSender);
        } else {
          said += 1;
          lastSender = step.user_id;
        }
      }
    }
  });

  it("talks about tickets of the story, alternating English and Serbian lines", () => {
    const { played } = chatStory(11, 800);
    const messages = played.filter(
      (p): p is typeof p & { step: Extract<ChatStep, { kind: "message" }> } =>
        p.step.kind === "message",
    );
    expect(messages.length).toBeGreaterThan(50);
    const closed = new Set<string>();
    let mentions = 0;
    for (const [i, { step, open }] of messages.entries()) {
      const language = i % 2 === 0 ? "en" : "sr";
      const line = CHAT_SCRIPT.find((l) => {
        const pattern = l[language]
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace("\\{t\\}", "T-\\d+")
          .replace("\\{r\\}", ".+");
        return new RegExp(`^${pattern}$`).test(step.content);
      });
      expect(line, `${language}: ${step.content}`).toBeDefined();
      const ticket = step.content.match(/T-\d+/)?.[0];
      if (ticket) {
        mentions += 1;
        if (line?.ticket === "open") expect(open).toContain(ticket);
      }
    }
    for (const { step } of played) {
      if (step.kind === "event" && step.event.event_type === "TICKET_CLOSED") {
        closed.add(String(step.event.instance_id));
      }
    }
    expect(mentions).toBeGreaterThan(10);
    // The same line is never said twice in a row, in either language.
    for (let i = 1; i < messages.length; i++) {
      const strip = (m: string) => m.replace(/T-\d+/g, "T");
      const same = CHAT_SCRIPT.some(
        (l) =>
          [l.en, l.sr]
            .map((x) => strip(x.replace("{t}", "T")))
            .includes(strip(messages[i - 1]?.step.content ?? "")) &&
          [l.en, l.sr]
            .map((x) => strip(x.replace("{t}", "T")))
            .includes(strip(messages[i]?.step.content ?? "")),
      );
      expect(same, messages[i]?.step.content).toBe(false);
    }
    for (const { step } of messages) {
      const ticket = step.content.match(/^(?:Closing|Zatvaram) (T-\d+)/)?.[1];
      if (ticket) expect(closed).toContain(ticket);
    }
  });

  it("starts from the members an existing room has", () => {
    const everybody = [...CAST, ...NEWCOMERS.map((n) => n.username)];
    const steps = chatStory(3, 500, everybody).played.map((p) => p.step);
    expect(steps.some((s) => s.kind === "join")).toBe(false);
    expect(
      steps.some((s) => s.kind === "message" && !ROOM_FOUNDERS.includes(s.user_id as never)),
    ).toBe(true);
  });
});

const handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;
let app: FastifyInstance | null = null;
let url: string;
let keys: { read: string; write: string };
let out: string[];
let err: string[];
const io = {
  out: (line: string) => void out.push(line),
  err: (line: string) => void err.push(line),
};
const ui = makeUi(false, null);

describe("memento simulate", () => {
  beforeEach(async () => {
    out = [];
    err = [];
    await handle.pool.query(
      "truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
    );
    await createTenant(handle.db, { slug: "demo", name: "Demo" });
    const key = async (scopes: string) =>
      (await createApiKey(handle.db, { tenant: "demo", name: scopes, scopes })).key;
    keys = { read: await key("read"), write: await key("write") };
    app = await buildApp({ db: handle.db, logger: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/memento`;
  });
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  afterAll(() => handle.close());

  const cli = (argv: string[]) =>
    runCli(["simulate", "--url", url, ...argv], { db: () => handle.db, io, timeZone: "UTC" });

  it("pushes one scene with --once and logs it as a rendered line", async () => {
    expect(
      await cli(["--key", keys.write, "--tenant", "demo", "--seed", "1", "--once", "--no-chat"]),
    ).toBe(0);
    expect(out).toHaveLength(1);
    // Seed 1 starts, like every story, with somebody logging in.
    expect(out[0]).toMatch(
      /^\[\d\d:\d\d:\d\d\] {2}USER_LOGIN +user\/\w+ {2}User \w+ logged in from 10\.0\.\d+\.\d+\. {2}→ /,
    );
    expect(err[0]).toContain("● simulate: a ticket desk (seed 1), one event every 3s");
    expect(err.at(-1)).toBe("simulate stopped: 1 pushed, 0 failed");
  });

  it("plays the same story for a seed, in the events UDC collection", async () => {
    expect(
      await runCli(
        [
          "--json",
          "simulate",
          "--url",
          url,
          "--key",
          keys.write,
          "--seed",
          "42",
          "--interval",
          "0.01",
          "--count",
          "25",
          "--locale",
          "sr",
          "--no-chat",
        ],
        { db: () => handle.db, io },
      ),
    ).toBe(0);
    const stored = out.map((line) => JSON.parse(line));
    const expected = story(42, 25);
    expect(stored.map((e) => [e.event_type, e.instance_id, e.actor_id])).toEqual(
      expected.map((e) => [e.event_type, e.instance_id, e.actor_id]),
    );
    const templated = stored.find((e) => e.event_type !== "NOTE");
    expect(templated.rendered).toMatch(/Korisnik|Kreiran|Zatvoren|Izmenjen/);

    const response = await (app as FastifyInstance).inject({
      method: "POST",
      url: "/memento/udc/list",
      headers: { authorization: `Bearer ${keys.read}` },
      payload: { collection: "events", page: { limit: 100 } },
    });
    expect(response.json().payload.total).toBe(25);
  });

  it("retries the same scene after a failed push, stops on a refused key", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) throw new Error("ECONNREFUSED");
      return fetch(input, init);
    };
    const summary = await runSimulate(
      { url, apiKey: keys.write, interval: 1, seed: 3, count: 3, chat: false },
      { io, ui, json: true, fetch: flaky, sleep: async () => {} },
    );
    expect(summary).toEqual({ seed: 3, pushed: 2, failed: 1 });
    expect(err).toContain("● reconnected after 1 failed push(es)");
    const pushed = out.map((line) => JSON.parse(line).instance_id);
    expect(pushed).toEqual(story(3, 2).map((e) => e.instance_id));

    expect(await cli(["--key", keys.read, "--once", "--no-chat"])).toBe(1);
    expect(err.at(-1)).toBe('error: push refused: this API key lacks the "write" scope');
    expect(await cli(["--key", keys.read, "--once"])).toBe(1);
    expect(err.at(-1)).toBe('error: room refused: this API key lacks the "write" scope');
    expect(await cli(["--once"])).toBe(1);
    expect(err.at(-1)).toContain("no API key");
    expect(await cli(["--key", keys.write, "--interval", "0"])).toBe(1);
  });

  it("stops when the signal aborts and prints a random seed", async () => {
    const stop = new AbortController();
    const summary = await runSimulate(
      { url, apiKey: keys.write, interval: 60 },
      { io, ui, json: false, signal: stop.signal, sleep: async () => stop.abort() },
    );
    expect(summary.pushed).toBe(1);
    expect(err[0]).toContain(`(seed ${summary.seed})`);
    expect(err[0]).toContain("(Ctrl+C to stop)");
  });

  const inject = (path: string, key = keys.read) =>
    (app as FastifyInstance).inject({
      method: "GET",
      url: `/memento${path}`,
      headers: { authorization: `Bearer ${key}` },
    });

  it("creates the demo room once: a second run talks in the same room", async () => {
    expect(await cli(["--key", keys.write, "--seed", "1", "--once"])).toBe(0);
    expect(err[0]).toContain("● simulate: a ticket desk and chat-demo-room (seed 1)");
    expect(err[1]).toBe('● created chat-demo-room "Demo room": igor, marko, ana, jelena');
    err = [];
    expect(await cli(["--key", keys.write, "--seed", "2", "--once"])).toBe(0);
    // A write-only key cannot read the room's members: it keeps the founders.
    expect(err[1]).toBe('● talking in chat-demo-room "Demo room": igor, marko, ana, jelena');

    const chats = (await inject("/chats?user_id=igor")).json().data;
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ chat_id: ROOM_ID, kind: "room", name: "Demo room" });

    // A key that may read finds the room's members through GET /chats?user_id=.
    const both = (
      await createApiKey(handle.db, { tenant: "demo", name: "rw", scopes: "read,write" })
    ).key;
    await (app as FastifyInstance).inject({
      method: "POST",
      url: `/memento/chats/${ROOM_ID}/participants`,
      headers: { authorization: `Bearer ${both}` },
      payload: { user_id: "mila", added_by: "igor" },
    });
    const client = new MementoClient({ baseUrl: url, apiKey: both });
    const found = await ensureRoom(client);
    expect(found.created).toBe(false);
    expect(found.members.sort()).toEqual(["ana", "igor", "jelena", "marko", "mila"]);
  });

  it("talks in the room as its members: every message from a participant, seen markers, joins", async () => {
    expect(
      await runCli(
        ["--json", "simulate", "--url", url, "--key", keys.write, "--seed", "4"].concat([
          "--interval",
          "0.001",
          "--count",
          "150",
        ]),
        { db: () => handle.db, io },
      ),
    ).toBe(0);
    expect(err.some((line) => line.startsWith("✗"))).toBe(false);
    const stored = out.map((line) => JSON.parse(line));
    const chat = stored.filter((e) => e.instance_type === "chat");
    expect(new Set(chat.map((e) => e.event_type))).toEqual(
      new Set(["CHAT_MESSAGE_SENT", "CHAT_MESSAGE_SEEN", "CHAT_PARTICIPANT_ADDED"]),
    );
    expect(chat.every((e) => e.instance_id === ROOM_ID)).toBe(true);

    const room = (await inject(`/chats/${ROOM_ID}?user_id=igor`)).json().data;
    const members = new Set(room.participants.map((p: { user_id: string }) => p.user_id));
    const all = (
      await inject(`/chats/${ROOM_ID}/messages?user_id=igor&event_type=CHAT_*&limit=500`)
    ).json().data;
    expect(all).toHaveLength(chat.length);
    for (const e of all) {
      if (e.event_type === "CHAT_MESSAGE_SENT") expect(members).toContain(e.payload.sender_user_id);
      if (e.event_type === "CHAT_MESSAGE_SEEN") expect(members).toContain(e.payload.user_id);
      if (e.event_type === "CHAT_PARTICIPANT_ADDED") expect(members).toContain(e.payload.added_by);
    }
    // Somebody other than the founders was added, and read markers moved.
    expect(members.size).toBeGreaterThan(ROOM_FOUNDERS.length);
    expect(
      room.participants.some((p: { last_seen_event_id: string | null }) => p.last_seen_event_id),
    ).toBe(true);
  });

  it("takes a member who is in the room already quietly (write-only key, existing room)", async () => {
    const admin = (await createApiKey(handle.db, { tenant: "demo", name: "a", scopes: "admin" }))
      .key;
    const client = new MementoClient({ baseUrl: url, apiKey: admin });
    await client.createChat({
      chat_id: ROOM_ID,
      name: "Demo room",
      kind: "room",
      participants: [...CAST, ...NEWCOMERS.map((n) => n.username)],
    });
    const summary = await runSimulate(
      { url, apiKey: keys.write, interval: 1, seed: 4, count: 150 },
      { io, ui, json: false, sleep: async () => {}, timeZone: "UTC" },
    );
    expect(summary.failed).toBe(0);
    expect(summary.pushed).toBe(150);
    expect(out.some((line) => line.includes("join") && line.includes("nothing new to store"))).toBe(
      true,
    );
  });

  it("formats a story line", () => {
    const line = storyLine(
      {
        id: "e1",
        occurred_at: "2026-10-31T10:00:00Z",
        event_type: "NOTE",
        instance_type: "ticket",
        instance_id: "T-1",
        rendered: "Fix is in review.",
      } as never,
      ui,
      "UTC",
    );
    expect(line).toBe("[10:00:00]  NOTE             ticket/T-1  Fix is in review.  → e1");
  });
});
