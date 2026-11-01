import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import type { Plugin, ViteDevServer } from "vite";
import type {
  ClientFile,
  ClientProgram,
  ClientReadme,
  ReadmeBlock,
} from "./src/pages/clients/types.js";

/**
 * `vite-plugin-clients`: the `/clients` page's content, read from `clients/<lang>/` at the
 * repository root every time the site is built (and live in dev), so the page is always what
 * is committed there — nothing is copied into the app by hand.
 *
 * - `virtual:clients` — a JSON module, per language `{id, label, run, readme, files, zip}`;
 *   each file's source is highlighted by shiki here, so the browser ships no grammars.
 * - `dist/clients/<lang>.zip` — the directory zipped (`<lang>/…` inside), without
 *   `node_modules`, `target`, `build` and what the directory's own `.gitignore` names;
 *   in dev the same zip is answered at `/clients/<lang>.zip`.
 */

/** The tabs, in the page's order: directory, label, the files shown (main program first). */
export const CLIENT_LANGUAGES = [
  { id: "javascript", label: "JavaScript", files: ["memento.mjs"] },
  { id: "typescript", label: "TypeScript", files: ["memento.ts", "package.json"] },
  { id: "python", label: "Python", files: ["memento.py"] },
  { id: "php", label: "PHP", files: ["memento.php"] },
  { id: "java", label: "Java", files: ["Memento.java"] },
  { id: "rust", label: "Rust", files: ["src/main.rs", "Cargo.toml"] },
  { id: "golang", label: "Go", files: ["main.go", "go.mod"] },
  { id: "cpp", label: "C++", files: ["memento.cpp", "CMakeLists.txt"] },
] as const;

/** Directories never zipped: dependencies and build output. */
export const ZIP_EXCLUDED_DIRS = ["node_modules", "target", "build"];

const VIRTUAL_ID = "virtual:clients";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
/** A fixed time for every zip entry: the same `clients/` gives the same bytes. */
const ZIP_MTIME = new Date("2026-01-01T00:00:00Z");

/** `clients/` of this repository (apps/service/../../clients). */
export const DEFAULT_CLIENTS_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../clients",
);

// --- README ------------------------------------------------------------------------------

/** Which section a `##` heading opens: `Install`, `Set the two variables`, `Run`. */
function sectionOf(heading: string): keyof ClientReadme | null {
  const h = heading.trim().toLowerCase();
  if (h.startsWith("install")) return "install";
  if (h.includes("variable")) return "variables";
  if (h === "run" || h.startsWith("run ")) return "run";
  return null;
}

/** Paragraphs (joined lines) and fenced code blocks of a section's markdown. */
function blocksOf(lines: string[]): ReadmeBlock[] {
  const blocks: ReadmeBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "text", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i] ?? ""); i++)
        code.push(lines[i] ?? "");
      blocks.push({ kind: "code", lang: fence[1] ?? "", code: code.join("\n") });
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/**
 * A client README's three sections — install, the two variables, run — as blocks. Throws
 * when one is missing: the page would otherwise show a hole.
 */
export function parseReadme(markdown: string, where = "README.md"): ClientReadme {
  const lines: Record<keyof ClientReadme, string[] | undefined> = {
    install: undefined,
    variables: undefined,
    run: undefined,
  };
  let current: string[] | null = null;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      const key = sectionOf(heading[1] ?? "");
      current = null;
      if (key) {
        current = [];
        lines[key] = current;
      }
    } else if (/^#\s/.test(line)) {
      current = null;
    } else {
      current?.push(line);
    }
  }
  const missing = (Object.keys(lines) as (keyof ClientReadme)[]).filter((k) => !lines[k]);
  if (missing.length) {
    throw new Error(
      `${where}: no "## ${missing.join('", "## ')}" section (install / variables / run)`,
    );
  }
  return {
    install: blocksOf(lines.install ?? []),
    variables: blocksOf(lines.variables ?? []),
    run: blocksOf(lines.run ?? []),
  };
}

/** The run command: the first line of the run section's first code block. */
export function runLineOf(readme: ClientReadme, where = "README.md"): string {
  const block = readme.run.find((b) => b.kind === "code");
  const line = block?.kind === "code" ? block.code.split("\n").find((l) => l.trim()) : undefined;
  if (!line) throw new Error(`${where}: the "## Run" section has no code block`);
  return line.trim();
}

// --- zip ---------------------------------------------------------------------------------

/** The plain names a directory's `.gitignore` lists (`target/`, `memento-client`, …). */
function ignoredNames(dir: string): Set<string> {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim().replace(/^\/+|\/+$/g, ""))
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !/[*?[]/.test(l)),
  );
}

/** Every file of `dir` that goes into its zip, as posix paths relative to it, sorted. */
export function zipFilesOf(dir: string): string[] {
  const ignored = ignoredNames(dir);
  const files: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const rel = relative(dir, path).split(sep).join(posix.sep);
      if (ignored.has(rel) || ignored.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!ZIP_EXCLUDED_DIRS.includes(entry.name)) walk(path);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** `<id>.zip`: the files of `dir` under `<id>/`. */
export function zipClient(dir: string, id: string): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const rel of zipFilesOf(dir)) {
    entries[`${id}/${rel}`] = [readFileSync(join(dir, rel)), { mtime: ZIP_MTIME }];
  }
  return zipSync(entries, { level: 9 });
}

// --- highlighting ------------------------------------------------------------------------

const SHIKI_LANG: Record<string, string> = {
  mjs: "javascript",
  js: "javascript",
  ts: "typescript",
  py: "python",
  php: "php",
  java: "java",
  rs: "rust",
  go: "go",
  cpp: "cpp",
  json: "json",
  toml: "toml",
  "CMakeLists.txt": "cmake",
};

function shikiLangOf(name: string): string {
  const base = posix.basename(name);
  return SHIKI_LANG[base] ?? SHIKI_LANG[base.split(".").pop() ?? ""] ?? "text";
}

export type Highlight = (source: string, name: string) => Promise<string | undefined>;

/** Shiki with the `github-light` theme and only the grammars the clients need. */
export async function shikiHighlight(): Promise<Highlight> {
  const { createHighlighter } = await import("shiki");
  const langs = [...new Set(Object.values(SHIKI_LANG))];
  const highlighter = await createHighlighter({ themes: ["github-light"], langs });
  return async (source, name) => {
    const lang = shikiLangOf(name);
    return lang === "text"
      ? undefined
      : highlighter.codeToHtml(source, { lang, theme: "github-light" });
  };
}

// --- loading -----------------------------------------------------------------------------

/** Reads every language of `clientsDir`; throws with a clear message when anything is missing. */
export async function loadClients(
  clientsDir: string,
  highlight?: Highlight,
): Promise<ClientProgram[]> {
  if (!existsSync(clientsDir) || !statSync(clientsDir).isDirectory()) {
    throw new Error(
      `vite-plugin-clients: ${clientsDir} not found — the /clients page is built from the ` +
        "client programs in clients/<lang>/ at the repository root",
    );
  }
  const programs: ClientProgram[] = [];
  for (const lang of CLIENT_LANGUAGES) {
    const dir = join(clientsDir, lang.id);
    const readmePath = join(dir, "README.md");
    if (!existsSync(readmePath)) {
      throw new Error(`vite-plugin-clients: ${readmePath} not found`);
    }
    const readme = parseReadme(readFileSync(readmePath, "utf8"), readmePath);
    const files: ClientFile[] = [];
    for (const name of lang.files) {
      const path = join(dir, name);
      if (!existsSync(path)) throw new Error(`vite-plugin-clients: ${path} not found`);
      const source = readFileSync(path, "utf8");
      const html = await highlight?.(source, name);
      files.push(html ? { name, source, html } : { name, source });
    }
    programs.push({
      id: lang.id,
      label: lang.label,
      run: runLineOf(readme, readmePath),
      readme,
      files,
      zip: zipFilesOf(dir).map((rel) => `${lang.id}/${rel}`),
    });
  }
  return programs;
}

// --- the plugin --------------------------------------------------------------------------

export interface ClientsPluginOptions {
  /** Default: `clients/` at the repository root. */
  clientsDir?: string;
  /** Shiki at build time (default `true`); `false`: plain monospace on the page. */
  highlight?: boolean;
}

export function clientsPlugin(options: ClientsPluginOptions = {}): Plugin {
  const clientsDir = options.clientsDir ?? DEFAULT_CLIENTS_DIR;
  let highlighter: Promise<Highlight> | undefined;
  const highlight: Highlight | undefined =
    options.highlight === false
      ? undefined
      : async (source, name) => {
          highlighter ??= shikiHighlight();
          return (await highlighter)(source, name);
        };
  let isBuild = false;

  return {
    name: "memento-clients",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      // Dev reloads it when clients/ changes (configureServer, below).
      const programs = await loadClients(clientsDir, highlight);
      return `export default ${JSON.stringify(programs)};`;
    },
    async generateBundle() {
      if (!isBuild) return;
      for (const lang of CLIENT_LANGUAGES) {
        this.emitFile({
          type: "asset",
          fileName: `clients/${lang.id}.zip`,
          source: zipClient(join(clientsDir, lang.id), lang.id),
        });
      }
    },
    configureServer(server: ViteDevServer) {
      // Dev: the zip on request, and the page again when a client file changes.
      server.middlewares.use((req, res, next) => {
        const match = /^\/clients\/([a-z]+)\.zip(?:\?|$)/.exec(req.url ?? "");
        const lang = match && CLIENT_LANGUAGES.find((l) => l.id === match[1]);
        if (!lang) return next();
        const zip = zipClient(join(clientsDir, lang.id), lang.id);
        res.setHeader("content-type", "application/zip");
        res.setHeader("content-length", String(zip.byteLength));
        res.end(Buffer.from(zip));
      });
      server.watcher.add(clientsDir);
      const reload = (file: string) => {
        if (!file.startsWith(clientsDir + sep)) return;
        const parts = relative(clientsDir, file).split(sep);
        if (parts.some((p) => ZIP_EXCLUDED_DIRS.includes(p))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (!mod) return;
        server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("change", reload);
      server.watcher.on("add", reload);
      server.watcher.on("unlink", reload);
    },
  };
}
