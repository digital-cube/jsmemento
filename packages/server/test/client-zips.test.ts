/*
 * The client zips the service site serves (/clients/<lang>.zip) name the instance that serves
 * them: built from clients/<lang>/ as committed (which name production), localized by the
 * server to MEMENTO_SERVICE_URL. Fails when a source names the stage service again, or when a
 * zip served for one service names another.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENTS_SERVICE_URL, localizeZip } from "../src/client-zips.js";
import { uiRoutes } from "../src/ui.js";

const CLIENTS = fileURLToPath(new URL("../../../clients", import.meta.url));
/** The eight languages and the file that holds each one's defaults. */
const MAIN: Record<string, string> = {
  javascript: "memento.mjs",
  typescript: "memento.ts",
  python: "memento.py",
  php: "memento.php",
  java: "Memento.java",
  rust: "src/main.rs",
  golang: "main.go",
  cpp: "memento.cpp",
};
const STAGE = "service.stage.memento-service.org";

/**
 * `clients/<lang>/` as committed, zipped with `<lang>/…` inside like the service site builds
 * it (the files git tracks: a local build's binaries are not part of it).
 */
function zipOf(lang: string): Uint8Array {
  const root = join(CLIENTS, lang);
  const files = execFileSync("git", ["ls-files", "-z", "."], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[`${lang}/${file}`] = readFileSync(join(root, file));
  return zipSync(entries);
}

function textOf(zip: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(zip)).map(([name, data]) => [name, strFromU8(data)]),
  );
}

let dir: string;
const apps: FastifyInstance[] = [];

async function serve(serviceUrl?: string): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(uiRoutes, { root: dir, ...(serviceUrl ? { serviceUrl } : {}) });
  apps.push(app);
  return app;
}

async function download(app: FastifyInstance, lang: string): Promise<Record<string, string>> {
  const response = await app.inject({ method: "GET", url: `/clients/${lang}.zip` });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("application/zip");
  return textOf(response.rawPayload);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memento-client-zips-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>service</title>");
  mkdirSync(join(dir, "clients"));
  for (const lang of Object.keys(MAIN))
    writeFileSync(join(dir, "clients", `${lang}.zip`), zipOf(lang));
});

afterAll(async () => {
  for (const app of apps) await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("client zips", () => {
  it("are eight, and clients/ names the production service, never stage", () => {
    expect(readdirSync(CLIENTS, { withFileTypes: true }).filter((e) => MAIN[e.name])).toHaveLength(
      8,
    );
    for (const lang of Object.keys(MAIN)) {
      const files = textOf(zipOf(lang));
      for (const [name, text] of Object.entries(files)) expect(text, name).not.toContain(STAGE);
      const main = files[`${lang}/${MAIN[lang]}`] ?? "";
      expect(main).toContain(`${CLIENTS_SERVICE_URL}/memento`);
      expect(main).toContain(`${CLIENTS_SERVICE_URL}/keys`);
    }
  });

  it("served with MEMENTO_SERVICE_URL = production name production and not stage", async () => {
    const app = await serve(`${CLIENTS_SERVICE_URL}/`);
    for (const lang of Object.keys(MAIN)) {
      const files = await download(app, lang);
      for (const [name, text] of Object.entries(files)) expect(text, name).not.toContain(STAGE);
      expect(files[`${lang}/${MAIN[lang]}`]).toContain(`${CLIENTS_SERVICE_URL}/memento`);
    }
  });

  it("served by another instance name that instance's service", async () => {
    const host = "https://memento.test.example";
    const app = await serve(host);
    for (const lang of Object.keys(MAIN)) {
      const files = await download(app, lang);
      for (const [name, text] of Object.entries(files)) {
        expect(text, name).not.toContain(STAGE);
        expect(text, name).not.toContain(CLIENTS_SERVICE_URL);
      }
      const main = files[`${lang}/${MAIN[lang]}`] ?? "";
      expect(main).toContain(`${host}/memento`);
      expect(main).toContain(`${host}/keys`);
      expect(files[`${lang}/README.md`]).toContain(`MEMENTO_URL=${host}/memento`);
    }
  });

  it("served by stage name stage", async () => {
    const app = await serve(`https://${STAGE}`);
    const files = await download(app, "javascript");
    expect(files["javascript/memento.mjs"]).toContain(`https://${STAGE}/memento`);
    expect(files["javascript/memento.mjs"]).not.toContain(CLIENTS_SERVICE_URL);
  });

  it("are served as built without MEMENTO_SERVICE_URL", async () => {
    const app = await serve();
    const response = await app.inject({ method: "GET", url: "/clients/python.zip" });
    expect(response.statusCode).toBe(200);
    expect(
      Buffer.compare(response.rawPayload, readFileSync(join(dir, "clients", "python.zip"))),
    ).toBe(0);
  });

  it("keep binary entries byte for byte", () => {
    const binary = new Uint8Array([
      0xff,
      0xfe,
      ...new TextEncoder().encode(CLIENTS_SERVICE_URL),
      0x80,
    ]);
    const zip = zipSync({
      "x/bin": binary,
      "x/a.txt": new TextEncoder().encode(CLIENTS_SERVICE_URL),
    });
    const out = unzipSync(localizeZip(zip, "https://elsewhere.example"));
    expect(Buffer.compare(Buffer.from(out["x/bin"] ?? []), Buffer.from(binary))).toBe(0);
    expect(strFromU8(out["x/a.txt"] ?? new Uint8Array())).toBe("https://elsewhere.example");
  });

  it("keep a zip that names no service as it is", () => {
    const zip = zipSync({ "x/a.txt": new TextEncoder().encode("nothing here") });
    expect(localizeZip(zip, "https://elsewhere.example")).toBe(zip);
  });
});
