#!/usr/bin/env node
/**
 *   npm run check:snippets        (also the second half of `npm run typecheck`)
 *
 * The code the home page and Get started show is a file of the repository imported `?raw`
 * (snippets/, clients/), never typed into a page. This keeps it that way:
 *
 *   1. no code fence in the home page or under get-started/, and no ts/tsx/js/jsx fence in any
 *      page: their code comes from snippets/ (the pages scripts/gen-*.mjs writes from docs/ and
 *      CHANGELOG.md are those files, so they are left out);
 *   1b. every clients/<lang>/ with a README.md has its page, src/content/docs/clients/<lang>.mdx,
 *      and every such page a directory: a ninth language cannot be left off the site;
 *   2. snippets/wire/: every file is valid JSON (ws.out.txt: frames separated by a blank line)
 *      and every request body `<name>.json` has the answer `<name>.out.json` scripts/capture.mjs
 *      recorded for it;
 *   3. `tsc -p snippets`: the embedded server, the stream client and the React app compile
 *      against the workspace's @memento/server, @memento/core and @memento/react (their
 *      sources, through the `@memento/source` condition), so a renamed option fails here.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "src", "content", "docs");
const WIRE = join(ROOT, "snippets", "wire");
const failures = [];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

// --- 1. no code typed into the pages -----------------------------------------------------
for (const file of walk(DOCS)) {
  if (!/\.mdx?$/.test(file)) continue;
  const path = relative(DOCS, file);
  const strict = path === "index.mdx" || path.startsWith("get-started/");
  const text = readFileSync(file, "utf8");
  if (/^<!-- Written by scripts\/gen-/m.test(text)) continue;
  for (const m of text.matchAll(/^\s*```(\w*)/gm)) {
    if (!strict && !/^(ts|tsx|js|jsx|typescript|javascript)$/.test(m[1] ?? "")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    failures.push(`src/content/docs/${path}:${line}: a \`\`\`${m[1]} fence; put it in snippets/`);
  }
}

// --- 1b. a page per client program ------------------------------------------------------
const CLIENTS = join(ROOT, "..", "..", "clients");
const languages = readdirSync(CLIENTS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(CLIENTS, e.name, "README.md")))
  .map((e) => e.name);
const clientPages = readdirSync(join(DOCS, "clients"))
  .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
  .map((f) => f.replace(/\.mdx$/, ""));
for (const lang of languages)
  if (!clientPages.includes(lang))
    failures.push(`clients/${lang}/: no page src/content/docs/clients/${lang}.mdx`);
for (const page of clientPages)
  if (!languages.includes(page))
    failures.push(`src/content/docs/clients/${page}.mdx: no clients/${page}/README.md`);

// --- 2. the recorded requests and answers ------------------------------------------------
const wire = readdirSync(WIRE);
for (const name of wire) {
  const text = readFileSync(join(WIRE, name), "utf8");
  const parts = name === "ws.out.txt" ? text.trim().split("\n\n") : [text];
  for (const part of parts) {
    try {
      JSON.parse(part);
    } catch (error) {
      failures.push(`snippets/wire/${name}: not JSON (${error.message})`);
    }
  }
  if (name.endsWith(".json") && !name.endsWith(".out.json")) {
    const answer = name.replace(/\.json$/, ".out.json");
    if (!wire.includes(answer))
      failures.push(`snippets/wire/${name}: no ${answer}; run npm run capture`);
  }
}

// --- 3. compile ------------------------------------------------------------------------
const tsc = join(ROOT, "node_modules", ".bin", "tsc");
if (!existsSync(tsc)) failures.push("no node_modules/.bin/tsc: pnpm install first");
else {
  const r = spawnSync(tsc, ["-p", join(ROOT, "snippets")], { stdio: "inherit" });
  if (r.status !== 0) failures.push("tsc -p snippets failed (above)");
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("snippets ok: no typed code in the pages, wire/ recorded, snippets compile");
