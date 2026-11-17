/*
 * scripts/check-hosts.mjs on a made-up dist/: a production build may not name stage's service.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isStage, stageMentions } from "../scripts/check-hosts.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/check-hosts.mjs", import.meta.url));

function dist(files) {
  const dir = mkdtempSync(join(tmpdir(), "memento-hosts-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const run = (dir, serviceUrl) =>
  spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: "utf8",
    env: { ...process.env, SERVICE_URL: serviceUrl },
  });

test("isStage: by host", () => {
  assert.equal(isStage("https://service.stage.memento-service.org"), true);
  assert.equal(isStage("https://stage.memento-service.org/"), true);
  assert.equal(isStage("https://service.memento-service.org"), false);
  assert.equal(isStage("http://localhost:8201"), false);
});

test("stageMentions: file and line of every stage service host, in text files only", () => {
  const dir = dist({
    "index.html":
      "<p>ok</p>\n<code>curl -O https://service.stage.memento-service.org/clients/javascript.zip</code>",
    "get-started/index.html": '<a href="https://service.memento-service.org/keys">Keys</a>',
    "_astro/x.js": "const u='https://service.stage.example.org/memento';",
    "logo.png": "service.stage.memento-service.org",
  });
  try {
    assert.deepEqual(stageMentions(dir), [
      "_astro/x.js:1: service.stage.example.org",
      "index.html:2: service.stage.memento-service.org",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a production build that names stage's service fails; a stage build may", () => {
  const dir = dist({ "index.html": "https://service.stage.memento-service.org/memento" });
  try {
    const prod = run(dir, "https://service.memento-service.org");
    assert.equal(prod.status, 1, prod.stdout + prod.stderr);
    assert.match(prod.stderr, /index\.html:1: service\.stage\.memento-service\.org/);
    const stage = run(dir, "https://service.stage.memento-service.org");
    assert.equal(stage.status, 0, stage.stdout + stage.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a production build without stage passes", () => {
  const dir = dist({ "index.html": "https://service.memento-service.org/memento" });
  try {
    const prod = run(dir, "https://service.memento-service.org");
    assert.equal(prod.status, 0, prod.stdout + prod.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
