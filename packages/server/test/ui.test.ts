import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../src/db/client.js";
import { uiRoutes } from "../src/ui.js";
import { type Fixture, setupApp, testDatabase } from "./helpers.js";

const INDEX =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>';

let dir: string;
let handle: DatabaseHandle;
let fixture: Fixture;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "memento-ui-"));
  writeFileSync(join(dir, "index.html"), INDEX);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log('cpu monitor');");
  handle = testDatabase();
  fixture = await setupApp(handle, { ui: { root: dir } });
});

afterAll(async () => {
  await fixture.app.close();
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("web UI", () => {
  it("serves index.html at /", async () => {
    const response = await fixture.app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.body).toBe(INDEX);
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("serves index.html at /en/ and redirects /en to it", async () => {
    const page = await fixture.app.inject({ method: "GET", url: "/en/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.body).toBe(INDEX);

    const bare = await fixture.app.inject({ method: "GET", url: "/en?x=1" });
    expect(bare.statusCode).toBe(301);
    expect(bare.headers.location).toBe("/en/");
  });

  it("serves hashed assets with a long cache", async () => {
    const response = await fixture.app.inject({ method: "GET", url: "/assets/index-abc.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("falls back to index.html for client routes that want a page", async () => {
    const page = await fixture.app.inject({
      method: "GET",
      url: "/some/route?f=1",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(INDEX);

    const asset = await fixture.app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(asset.statusCode).toBe(404);
    expect(asset.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("leaves the API alone", async () => {
    const health = await fixture.app.inject({ method: "GET", url: "/memento/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const missing = await fixture.app.inject({
      method: "GET",
      url: "/memento/nope",
      headers: { accept: "text/html" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses a directory without index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "memento-ui-empty-"));
    const app = Fastify({ logger: false });
    try {
      await expect(app.register(uiRoutes, { root: empty }).ready()).rejects.toThrow(/index\.html/);
    } finally {
      await app.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
