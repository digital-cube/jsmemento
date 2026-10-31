import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DemoKeyError, resolveDemoKey } from "../src/demo.js";
import { createApiKey, revokeApiKey } from "../src/services/apikeys.js";
import { DEFAULT_MENU_PATH, MENU_COLLECTION_ICONS } from "../src/udc/menu.js";
import { auth, type Fixture, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let dir: string;
let fx: Fixture | null = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memento-menu-"));
});
afterEach(async () => {
  await fx?.app.close();
  fx = null;
});
afterAll(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: the tests read deep into protocol payloads
async function udc(action: string, payload: unknown, key: string): Promise<Record<string, any>> {
  const response = await (fx as Fixture).app.inject({
    method: "POST",
    url: `/memento/udc/${action}`,
    headers: auth(key),
    payload: payload as Record<string, unknown>,
  });
  const answer = response.json();
  expect(answer.kind, JSON.stringify(answer.payload)).toBe(`udc.${action}.ok`);
  return answer.payload;
}

describe("the menu collection", () => {
  it("is served from menu.yaml next to events and cpu_load, udc:collections resolved", async () => {
    fx = await setupApp(handle, { menu: DEFAULT_MENU_PATH });
    const { collections } = await udc("collections", {}, fx.keys.read);
    expect(collections.map((c: { name: string }) => c.name)).toEqual([
      "events",
      "cpu_load",
      "menu",
    ]);
    expect(collections[2]).toMatchObject({ source_kind: "yaml_menu", group: "files" });
    const d = await udc("describe", { collection: "menu" }, fx.keys.read);
    expect(d.source_kind).toBe("yaml_menu");

    const { rows } = await udc("list", { collection: "menu" }, fx.keys.read);
    const byCode = Object.fromEntries(rows.map((r: { code: string }) => [r.code, r]));
    expect(rows.map((r: { code: string }) => r.code)).toEqual([
      "HOME",
      "EXAMPLES",
      "CPU_MONITOR",
      "COLLECTIONS",
      "COLLECTION_EVENTS",
      "COLLECTION_CPU_LOAD",
      "COLLECTION_MENU",
    ]);
    expect(byCode.CPU_MONITOR).toMatchObject({
      url: "/examples/cpu-monitor",
      translation_key: "MENU_CPU_MONITOR",
      parent_id: byCode.EXAMPLES.__meta.id,
      is_dynamic: false,
    });
    expect(byCode.COLLECTION_CPU_LOAD).toMatchObject({
      url: "/udc/cpu_load",
      translation_key: "COLLECTIONS_CPU_LOAD",
      icon: MENU_COLLECTION_ICONS.cpu_load,
      parent_id: byCode.COLLECTIONS.__meta.id,
      is_dynamic: true,
    });
  });

  it("is the same for every tenant, and still needs a key", async () => {
    fx = await setupApp(handle, { menu: DEFAULT_MENU_PATH });
    const mine = await udc("list", { collection: "menu" }, fx.keys.read);
    const theirs = await udc("list", { collection: "menu" }, fx.keys.otherRead);
    expect(theirs.rows).toEqual(mine.rows);
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/udc/list",
      payload: { collection: "menu" },
    });
    expect(response.json().payload.code).toBe("forbidden");
  });

  it("is read again when the file changes", async () => {
    const file = join(dir, "menu.yaml");
    copyFileSync(DEFAULT_MENU_PATH, file);
    fx = await setupApp(handle, { menu: file });
    expect((await udc("list", { collection: "menu" }, fx.keys.read)).rows[0].code).toBe("HOME");
    writeFileSync(file, "- code: ONLY\n  url: /only\n");
    const { rows } = await udc("list", { collection: "menu" }, fx.keys.read);
    expect(rows.map((r: { code: string }) => r.code)).toEqual(["ONLY"]);
  });

  it("is not served without a menu, and a missing file fails startup", async () => {
    fx = await setupApp(handle);
    const { collections } = await udc("collections", {}, fx.keys.read);
    expect(collections.map((c: { name: string }) => c.name)).not.toContain("menu");
    await expect(
      buildApp({ db: handle.db, logger: false, menu: join(dir, "nope.yaml") }),
    ).rejects.toThrow(/cannot read the menu/);
  });

  it("is configured by MEMENTO_MENU_PATH, menu.yaml at the root by default", () => {
    expect(loadConfig({}).menuPath).toBe(DEFAULT_MENU_PATH);
    expect(DEFAULT_MENU_PATH).toMatch(/[\\/]menu\.yaml$/);
    expect(loadConfig({ MEMENTO_MENU_PATH: "/app/config/menu.yaml" }).menuPath).toBe(
      "/app/config/menu.yaml",
    );
  });
});

describe("GET /api/demo", () => {
  const demo = () => (fx as Fixture).app.inject({ method: "GET", url: "/memento/api/demo" });

  it("is 404 without a demo key", async () => {
    fx = await setupApp(handle);
    const response = await demo();
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("hands out a read-only key without auth, and the key works", async () => {
    fx = await setupApp(handle);
    const key = fx.keys.read;
    await fx.app.close();
    fx = { ...fx, app: await buildApp({ db: handle.db, logger: false, demoApiKey: ` ${key}` }) };
    const response = await demo();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ ok: true, data: { api_key: key, tenant: "acme" } });
    const listed = await udc("collections", {}, response.json().data.api_key);
    expect(listed.collections.length).toBeGreaterThan(0);
  });

  it("refuses to start with a write, admin, unknown or revoked key", async () => {
    fx = await setupApp(handle);
    const start = (demoApiKey: string) => buildApp({ db: handle.db, logger: false, demoApiKey });
    await expect(start(fx.keys.write)).rejects.toThrow(
      "MEMENTO_DEMO_API_KEY must be a read-only key",
    );
    await expect(start(fx.keys.admin)).rejects.toBeInstanceOf(DemoKeyError);
    await expect(start("mk_nope_nope")).rejects.toThrow(/unknown, revoked or expired/);
    const both = await createApiKey(handle.db, {
      tenant: "acme",
      name: "rw",
      scopes: "read,write",
    });
    await expect(resolveDemoKey(handle.db, both.key)).rejects.toThrow(/scopes read,write/);
    const gone = await createApiKey(handle.db, { tenant: "acme", name: "gone", scopes: "read" });
    await expect(resolveDemoKey(handle.db, gone.key)).resolves.toEqual({
      apiKey: gone.key,
      tenant: "acme",
    });
    await revokeApiKey(handle.db, gone.apiKey.prefix);
    await expect(resolveDemoKey(handle.db, gone.key)).rejects.toBeInstanceOf(DemoKeyError);
  });

  it("is configured by MEMENTO_DEMO_API_KEY; empty means none", () => {
    expect(loadConfig({}).demoApiKey).toBeNull();
    expect(loadConfig({ MEMENTO_DEMO_API_KEY: "" }).demoApiKey).toBeNull();
    expect(loadConfig({ MEMENTO_DEMO_API_KEY: " mk_a_b " }).demoApiKey).toBe("mk_a_b");
  });
});
