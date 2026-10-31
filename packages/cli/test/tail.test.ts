import type { AddressInfo } from "node:net";
import {
  buildApp,
  connect,
  createApiKey,
  createTenant,
  LocalBus,
  loadConfig,
} from "@memento/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { clock, makeUi, runCli, tailLine, tailQuery } from "../src/index.js";

const handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
let out: string[];
let err: string[];
type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;
let app: FastifyInstance | null = null;
let url: string;
let keys: { read: string; write: string };
const waiters: (() => void)[] = [];
const io = {
  out: (line: string) => {
    out.push(line);
    for (const wake of waiters.splice(0)) wake();
  },
  err: (line: string) => {
    err.push(line);
    for (const wake of waiters.splice(0)) wake();
  },
};

/** Resolves once `predicate` holds (checked after every line printed). */
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out; out=${out} err=${err}`);
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 50);
    });
  }
}

beforeEach(async () => {
  out = [];
  err = [];
  await handle.pool.query(
    "truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
  );
  await createTenant(handle.db, { slug: "acme", name: "Acme" });
  keys = {
    read: (await createApiKey(handle.db, { tenant: "acme", name: "r", scopes: "read" })).key,
    write: (await createApiKey(handle.db, { tenant: "acme", name: "w", scopes: "write" })).key,
  };
  const bus = new LocalBus();
  app = await buildApp({ db: handle.db, publisher: bus, logger: false, stream: { feed: bus } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/memento`;
});
afterEach(async () => {
  await app?.close();
  app = null;
});
afterAll(() => handle.close());

const post = async (path: string, body: unknown) => {
  const response = await (app as FastifyInstance).inject({
    method: "POST",
    url: `/memento${path}`,
    headers: { authorization: `Bearer ${keys.write}` },
    payload: body as Record<string, unknown>,
  });
  if (response.statusCode >= 300) throw new Error(response.body);
  return response.json().data;
};

const tail = (argv: string[], signal: AbortSignal) =>
  runCli(["tail", "--url", url, "--api-key", keys.read, ...argv], {
    db: () => handle.db,
    io,
    signal,
    timeZone: "UTC",
  });

describe("memento tail", () => {
  it("prints the chat's last messages, then new ones as they are sent", async () => {
    await post("/chats", { participants: ["Igor", "Marko"], chat_id: "123" });
    await post("/chats/chat-123/messages", {
      user_id: "Marko",
      content: "Ćao!",
      occurred_at: "2026-10-31T09:59:00Z",
    });
    const stop = new AbortController();
    const done = tail(["--chat-id", "chat-123"], stop.signal);
    await until(() => err.some((line) => line.startsWith("● live")));
    expect(out).toEqual(["[09:59:00] Marko: Ćao!"]);
    expect(err).toEqual(["● live: following chat-123 (Ctrl+C to stop)"]);

    await post("/chats/chat-123/messages", {
      user_id: "Igor",
      content: "Pozdrav!",
      occurred_at: "2026-10-31T10:00:00Z",
    });
    // Not a message, and another chat: neither is printed.
    await post("/chats/chat-123/seen", { user_id: "Marko" });
    await post("/chats", { participants: ["Igor", "Ana"], chat_id: "999" });
    await post("/chats/chat-999/messages", { user_id: "Ana", content: "elsewhere" });
    await until(() => out.length === 2);
    expect(out[1]).toBe("[10:00:00] Igor: Pozdrav!");

    stop.abort();
    expect(await done).toBe(0);
    expect(out).toHaveLength(2);
  });

  it("follows any filter, prints JSON lines and skips history with -n 0", async () => {
    await post("/events", { event_type: "USER_LOGIN", instance_type: "user", instance_id: "1" });
    const stop = new AbortController();
    process.env.MEMENTO_API_KEY = keys.read;
    const done = runCli(["--json", "tail", "--url", url, "--event-type", "USER_*", "-n", "0"], {
      db: () => handle.db,
      io,
      signal: stop.signal,
      fetch: (input, init) => fetch(input, init),
      WebSocket: globalThis.WebSocket,
    });
    try {
      await until(() => err.some((line) => line.startsWith("● live")));
    } finally {
      delete process.env.MEMENTO_API_KEY;
    }
    expect(err[0]).toBe("● live: following event_type=USER_* (Ctrl+C to stop)");
    expect(out).toEqual([]);
    await post("/events", {
      event_type: "NOTE",
      instance_type: "user",
      instance_id: "1",
      payload: { text: "n" },
    });
    await post("/events", {
      event_type: "USER_LOGOUT",
      instance_type: "user",
      instance_id: "1",
      actor_id: "igor",
    });
    await until(() => out.length === 1);
    expect(JSON.parse(out[0] as string)).toMatchObject({
      event_type: "USER_LOGOUT",
      actor_id: "igor",
    });
    stop.abort();
    expect(await done).toBe(0);
  });

  it("reports the drop and reconnects when the server comes back", async () => {
    const stop = new AbortController();
    const done = tail(["--event-type", "NOTE"], stop.signal);
    await until(() => err.length === 1);
    const port = ((app as FastifyInstance).server.address() as AddressInfo).port;
    // A server shutdown closes every connection with 1001.
    await (app as FastifyInstance).close();
    await until(() => err.some((line) => line.startsWith("○ offline")));
    expect(err[1]).toBe("○ offline: connection closed (code 1001), reconnecting in 1s");
    const bus = new LocalBus();
    app = await buildApp({ db: handle.db, publisher: bus, logger: false, stream: { feed: bus } });
    await app.listen({ host: "127.0.0.1", port });
    await until(() => err.some((line) => line.includes("reconnected to")));
    expect(err.at(-1)).toBe("● live: reconnected to event_type=NOTE (Ctrl+C to stop)");
    await post("/events", {
      event_type: "NOTE",
      instance_type: "user",
      instance_id: "1",
      payload: { text: "back" },
    });
    await until(() => out.length === 1);
    expect(out[0]).toMatch(/^\[\d\d:\d\d:\d\d\] NOTE user\/1 back$/);
    stop.abort();
    expect(await done).toBe(0);
  }, 15_000);

  it("explains a bad key or an unreachable server", async () => {
    const stop = new AbortController();
    expect(
      await runCli(["tail", "--url", url, "--api-key", "mk_00000000_nope"], {
        db: () => handle.db,
        io,
        signal: stop.signal,
      }),
    ).toBe(1);
    expect(err).toEqual([
      "error: invalid or expired API key",
      "hint: check --key / --api-key / MEMENTO_API_KEY",
    ]);
    err = [];
    expect(
      await runCli(["tail", "--url", "http://127.0.0.1:1/memento", "--api-key", "k"], {
        db: () => handle.db,
        io,
      }),
    ).toBe(1);
    expect(err[0]).toMatch(/^error: cannot reach http:\/\/127\.0\.0\.1:1\/memento/);
    expect(err[1]).toBe(
      "hint: is the server running? start it with `pnpm dev`, or pass --url / MEMENTO_URL",
    );
    err = [];
    expect(await runCli(["tail", "--url", url], { db: () => handle.db, io })).toBe(1);
    expect(err).toEqual(["error: no API key: pass --api-key or set MEMENTO_API_KEY (scope read)"]);
    err = [];
    expect(await runCli(["tail", "-n", "-1"], { db: () => handle.db, io })).toBe(1);
    expect(err.join("\n")).toContain("must be 0 or a positive integer");
  });

  it("returns at once when already aborted, and reports other API errors plainly", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await tail(["-n", "0"], stop.signal)).toBe(0);
    expect(await tail(["--locale", "not a locale!"], stop.signal)).toBe(1);
    expect(err.at(-1)).toMatch(/^error: /);
  });
});

describe("tail formatting", () => {
  const ui = makeUi(false, null);
  const base = {
    id: "0199a000-0000-7000-8000-000000000001",
    occurred_at: "2026-10-31T10:00:00.000Z",
    received_at: "2026-10-31T10:00:00.000Z",
    instance_type: "user",
    instance_id: "42",
    actor_id: "igor",
    payload: {},
    rendered: "igor logged in",
    rendered_locale: "en",
    archived_at: null,
  };

  it("formats messages and other events", () => {
    expect(clock("2026-10-31T10:00:00Z", "Europe/Belgrade")).toBe("11:00:00");
    expect(tailLine({ ...base, event_type: "USER_LOGIN" }, ui, "UTC")).toBe(
      "[10:00:00] USER_LOGIN user/42 igor logged in",
    );
    expect(tailLine({ ...base, event_type: "NOTE", rendered: null }, ui, "UTC")).toBe(
      "[10:00:00] NOTE user/42",
    );
    expect(
      tailLine(
        { ...base, event_type: "CHAT_MESSAGE_SENT", payload: {}, actor_id: null, rendered: "r" },
        ui,
        "UTC",
      ),
    ).toBe("[10:00:00] ?: r");
    expect(
      tailLine(
        { ...base, event_type: "CHAT_MESSAGE_SENT", payload: {}, rendered: null },
        ui,
        "UTC",
      ),
    ).toBe("[10:00:00] igor: ");
    const colored = tailLine({ ...base, event_type: "USER_LOGIN" }, makeUi(true, null), "UTC");
    expect(colored).toContain("\u001b[");
  });

  it("builds the chat filter", () => {
    expect(tailQuery({ chatId: "7", lines: 10, url: "" })).toEqual({
      instance_type: "chat",
      instance_id: "chat-7",
      event_type: "CHAT_MESSAGE_SENT",
      actor_id: undefined,
    });
  });
});
