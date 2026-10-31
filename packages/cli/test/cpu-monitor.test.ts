import type { AddressInfo } from "node:net";
import { MementoApiError } from "@memento/core";
import { buildApp, connect, createApiKey, createTenant, loadConfig } from "@memento/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cpuEvent,
  cpuPayload,
  isFatal,
  makeUi,
  runCli,
  runCpuMonitor,
  sampleLine,
} from "../src/index.js";

const handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;
let app: FastifyInstance | null = null;
let url: string;
let keys: { read: string; write: string; admin: string };
let out: string[];
let err: string[];
const io = {
  out: (line: string) => void out.push(line),
  err: (line: string) => void err.push(line),
};
const ui = makeUi(false, null);
const noSleep = async () => {};

beforeEach(async () => {
  out = [];
  err = [];
  await handle.pool.query(
    "truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
  );
  await createTenant(handle.db, { slug: "demo", name: "Demo" });
  const key = async (scopes: string) =>
    (await createApiKey(handle.db, { tenant: "demo", name: scopes, scopes })).key;
  keys = { read: await key("read"), write: await key("write"), admin: await key("admin") };
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
  runCli(["cpu-monitor", "--url", url, ...argv], {
    db: () => handle.db,
    io,
    timeZone: "UTC",
  });

describe("cpu-monitor helpers", () => {
  it("rounds the load averages into a CPU_LOAD event", () => {
    expect(cpuPayload([0.123, 1.005, 2])).toEqual({
      load_1min: 0.12,
      load_5min: 1,
      load_15min: 2,
    });
    expect(cpuPayload([])).toEqual({ load_1min: 0, load_5min: 0, load_15min: 0 });
    expect(
      cpuEvent(
        { instanceType: "server", instanceId: "b1", actor: "monitor" },
        [1, 2, 3],
        new Date("2026-10-31T10:00:00Z"),
      ),
    ).toEqual({
      event_type: "CPU_LOAD",
      instance_type: "server",
      instance_id: "b1",
      actor_id: "monitor",
      occurred_at: "2026-10-31T10:00:00.000Z",
      payload: { load_1min: 1, load_5min: 2, load_15min: 3 },
    });
  });

  it("treats 4xx as fatal and everything else as retryable", () => {
    expect(isFatal(new MementoApiError(401, "unauthorized", "x"))).toBe(true);
    expect(isFatal(new MementoApiError(503, "unavailable", "x"))).toBe(false);
    expect(isFatal(new MementoApiError(0, "network_error", "x"))).toBe(false);
    expect(isFatal(new Error("x"))).toBe(false);
  });

  it("formats a sample line", () => {
    const line = sampleLine(
      {
        id: "e1",
        occurred_at: "2026-10-31T10:00:00Z",
        instance_type: "server",
        instance_id: "b1",
        payload: { load_1min: 0.5 },
      } as never,
      ui,
      "UTC",
    );
    expect(line).toBe("[10:00:00]  server/b1  load 0.50 - -  → e1");
  });
});

describe("memento cpu-monitor", () => {
  it("pushes CPU_LOAD events the cpu_load UDC collection serves", async () => {
    expect(
      await cli([
        "--key",
        keys.admin,
        "--tenant",
        "demo",
        "--instance-id",
        "backend-01",
        "--interval",
        "0.01",
        "--count",
        "3",
      ]),
    ).toBe(0);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^\[\d\d:\d\d:\d\d\] {2}server\/backend-01 {2}load \d+\.\d\d/);
    expect(err[0]).toContain("● cpu-monitor: pushing CPU_LOAD for server/backend-01 every 0.01s");
    expect(err.at(-1)).toBe("cpu-monitor stopped: 3 pushed, 0 failed");

    const response = await (app as FastifyInstance).inject({
      method: "POST",
      url: "/memento/udc/list",
      headers: { authorization: `Bearer ${keys.read}` },
      payload: { collection: "cpu_load" },
    });
    const { kind, payload } = response.json();
    expect(kind).toBe("udc.list.ok");
    expect(payload.total).toBe(3);
    expect(payload.rows[0]).toMatchObject({
      instance_type: "server",
      instance_id: "backend-01",
      load_1min: expect.any(Number),
      rendered: expect.stringMatching(/^Server backend-01 — CPU: /),
    });
  });

  it("prints stored events as JSON with --json; a write-only key skips the tenant check", async () => {
    expect(
      await runCli(
        [
          "--json",
          "cpu-monitor",
          "--url",
          url,
          "--api-key",
          keys.write,
          "--tenant",
          "demo",
          "--count",
          "1",
          "--locale",
          "sr",
        ],
        { db: () => handle.db, io },
      ),
    ).toBe(0);
    const event = JSON.parse(out[0] as string);
    expect(event).toMatchObject({
      event_type: "CPU_LOAD",
      actor_id: "monitor",
      rendered_locale: "sr",
    });
    expect(event.rendered).toContain("opterećenje CPU");
  });

  it("refuses a key of another tenant, a missing key and a bad interval", async () => {
    expect(await cli(["--key", keys.admin, "--tenant", "acme", "--count", "1"])).toBe(1);
    expect(err.at(-1)).toBe('error: this API key belongs to tenant "demo", not "acme"');
    expect(await cli(["--count", "1"])).toBe(1);
    expect(err.at(-1)).toContain("no API key");
    expect(await cli(["--key", keys.write, "--interval", "0"])).toBe(1);
    expect(err.join("\n")).toContain("must be a positive number");
  });

  it("stops at once on a refused key", async () => {
    expect(await cli(["--key", keys.read, "--count", "5"])).toBe(1);
    expect(out).toEqual([]);
    expect(err.at(-1)).toBe('error: push refused: this API key lacks the "write" scope');
  });

  it("logs a failed push and keeps going until the server answers again", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) throw new Error("ECONNREFUSED");
      if (calls === 3) return new Response("bad gateway", { status: 502 });
      return fetch(input, init);
    };
    const summary = await runCpuMonitor(
      { url, apiKey: keys.write, interval: 1, instanceType: "server", actor: "monitor", count: 4 },
      {
        io,
        ui,
        json: false,
        fetch: flaky,
        sleep: noSleep,
        loadavg: () => [1, 2, 3],
        hostname: () => "h1",
      },
    );
    expect(summary).toEqual({ pushed: 2, failed: 2 });
    expect(err).toContain(`✗ push failed: cannot reach ${url}: ECONNREFUSED — retrying`);
    expect(err).toContain("✗ push failed: HTTP 502 — retrying");
    expect(err).toContain("● reconnected after 2 failed push(es)");
    expect(out[0]).toContain("server/h1  load 1.00 2.00 3.00");
  });

  it("stops when the signal aborts", async () => {
    const stop = new AbortController();
    const summary = await runCpuMonitor(
      { url, apiKey: keys.write, interval: 60, instanceType: "server", actor: "monitor" },
      {
        io,
        ui,
        json: false,
        signal: stop.signal,
        loadavg: () => [0, 0, 0],
        sleep: async () => stop.abort(),
      },
    );
    expect(summary).toEqual({ pushed: 1, failed: 0 });
    expect(err[0]).toContain("(Ctrl+C to stop)");
  });

  it("wakes the default sleep on abort", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    await runCpuMonitor(
      { url, apiKey: keys.write, interval: 30, instanceType: "server", actor: "monitor" },
      { io, ui, json: false, signal: stop.signal },
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
