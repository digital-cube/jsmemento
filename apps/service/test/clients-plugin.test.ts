// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  CLIENT_LANGUAGES,
  DEFAULT_CLIENTS_DIR,
  loadClients,
  parseReadme,
  runLineOf,
  zipClient,
  zipFilesOf,
} from "../vite-plugin-clients.js";

const RUN_LINES: Record<string, string> = {
  javascript: "node memento.mjs",
  typescript: "npx tsx memento.ts",
  python: "python3 memento.py",
  php: "php memento.php",
  java: "java Memento.java",
  rust: "cargo run",
  golang: "go run .",
  cpp: "cmake -B build && cmake --build build && ./build/memento",
};

describe("parseReadme", () => {
  const readme = [
    "# JSMemento client — Go",
    "",
    "A complete program.",
    "",
    "## Install",
    "",
    "Go 1.23 or newer; `go run` fetches",
    "the one dependency.",
    "",
    "## Set the two variables",
    "",
    "```bash",
    "export MEMENTO_API_KEY=mk_…",
    "export MEMENTO_URL=https://example.org/memento",
    "```",
    "",
    "## Run",
    "",
    "```bash",
    "go run .",
    "```",
  ].join("\n");

  it("splits the three sections into paragraphs and code blocks", () => {
    const parsed = parseReadme(readme);
    expect(parsed.install).toEqual([
      { kind: "text", text: "Go 1.23 or newer; `go run` fetches the one dependency." },
    ]);
    expect(parsed.variables).toEqual([
      {
        kind: "code",
        lang: "bash",
        code: "export MEMENTO_API_KEY=mk_…\nexport MEMENTO_URL=https://example.org/memento",
      },
    ]);
    expect(runLineOf(parsed)).toBe("go run .");
  });

  it("refuses a README without one of the sections", () => {
    expect(() =>
      parseReadme("# x\n\n## Install\n\nfoo\n\n## Run\n\n```\nx\n```\n", "x.md"),
    ).toThrow(/x\.md: no "## variables" section/);
  });
});

describe("the real clients/ directory", () => {
  it("every README parses, with the run line of clients/README.md", async () => {
    const programs = await loadClients(DEFAULT_CLIENTS_DIR);
    expect(programs.map((p) => p.label)).toEqual([
      "JavaScript",
      "TypeScript",
      "Python",
      "PHP",
      "Java",
      "Rust",
      "Go",
      "C++",
    ]);
    for (const program of programs) {
      expect(program.run).toBe(RUN_LINES[program.id]);
      expect(program.readme.install.length).toBeGreaterThan(0);
      expect(program.readme.variables.some((b) => b.kind === "code")).toBe(true);
      expect(program.files[0]?.source.length).toBeGreaterThan(100);
      // No key in any file shown on the page.
      for (const file of program.files) expect(file.source).not.toMatch(/mk_[A-Za-z0-9]{8,}/);
    }
  });

  it("each zip holds the committed files, no dependencies or build output", () => {
    const zipped = Object.fromEntries(
      CLIENT_LANGUAGES.map((l) => [l.id, zipFilesOf(join(DEFAULT_CLIENTS_DIR, l.id))]),
    );
    expect(zipped).toEqual({
      javascript: ["README.md", "memento.mjs"],
      typescript: ["README.md", "memento.ts", "package.json"],
      python: ["README.md", "memento.py"],
      php: ["README.md", "memento.php"],
      java: ["Memento.java", "README.md"],
      rust: [".gitignore", "Cargo.lock", "Cargo.toml", "README.md", "src/main.rs"],
      golang: [".gitignore", "README.md", "go.mod", "go.sum", "main.go"],
      cpp: [".gitignore", "CMakeLists.txt", "README.md", "memento.cpp"],
    });
  });

  it("the zip unpacks into <lang>/ with the files' bytes", () => {
    const entries = unzipSync(zipClient(join(DEFAULT_CLIENTS_DIR, "golang"), "golang"));
    expect(Object.keys(entries).sort()).toEqual([
      "golang/.gitignore",
      "golang/README.md",
      "golang/go.mod",
      "golang/go.sum",
      "golang/main.go",
    ]);
    expect(new TextDecoder().decode(entries["golang/go.mod"])).toMatch(/^module /m);
  });
});

describe("loadClients", () => {
  it("fails with a clear message when clients/ is missing", async () => {
    await expect(loadClients("/nonexistent/clients")).rejects.toThrow(
      /\/nonexistent\/clients not found — the \/clients page is built from/,
    );
  });

  it("skips node_modules, target, build and the directory's .gitignore names", () => {
    const dir = mkdtempSync(join(tmpdir(), "clients-"));
    for (const sub of ["node_modules/x", "target/debug", "build", "src"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, "node_modules/x/index.js"), "");
    writeFileSync(join(dir, "target/debug/app"), "");
    writeFileSync(join(dir, "build/app"), "");
    writeFileSync(join(dir, "src/main.rs"), "");
    writeFileSync(join(dir, "binary"), "");
    writeFileSync(join(dir, ".gitignore"), "# built\nbinary\n");
    expect(zipFilesOf(dir)).toEqual([".gitignore", "src/main.rs"]);
  });
});
