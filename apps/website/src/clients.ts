/*
 * The client programs of clients/<lang>/, read when the site is built: the Clients pages show
 * these files, never a copy. The order, labels and shown files are the service site's
 * (CLIENT_LANGUAGES in apps/service/vite-plugin-clients.ts), so both sites show the same
 * program the same way; scripts/check-snippets.mjs fails when a clients/ directory has no page.
 */

/** In the page order: directory, label, the files shown (main program first), their languages. */
export const LANGUAGES = [
  { id: "javascript", label: "JavaScript", files: [["memento.mjs", "js"]] },
  {
    id: "typescript",
    label: "TypeScript",
    files: [
      ["memento.ts", "ts"],
      ["package.json", "json"],
    ],
  },
  { id: "python", label: "Python", files: [["memento.py", "python"]] },
  { id: "php", label: "PHP", files: [["memento.php", "php"]] },
  { id: "java", label: "Java", files: [["Memento.java", "java"]] },
  {
    id: "rust",
    label: "Rust",
    files: [
      ["src/main.rs", "rust"],
      ["Cargo.toml", "toml"],
    ],
  },
  {
    id: "golang",
    label: "Go",
    files: [
      ["main.go", "go"],
      ["go.mod", "go"],
    ],
  },
  {
    id: "cpp",
    label: "C++",
    files: [
      ["memento.cpp", "cpp"],
      ["CMakeLists.txt", "cmake"],
    ],
  },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]["id"];

/** Every file the pages show, by repository path (`clients/rust/src/main.rs`). */
const sources = import.meta.glob<string>(
  [
    "../../../clients/README.md",
    "../../../clients/*/README.md",
    "../../../clients/*/memento.*",
    "../../../clients/java/Memento.java",
    "../../../clients/golang/{main.go,go.mod}",
    "../../../clients/rust/{src/main.rs,Cargo.toml}",
    "../../../clients/typescript/package.json",
    "../../../clients/cpp/CMakeLists.txt",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** The text of a repository file under clients/; a missing one fails the build. */
export function clientFile(path: string): string {
  const text = sources[`../../../${path}`];
  if (text === undefined) throw new Error(`no ${path}: the Clients pages show it`);
  return text;
}

export function language(id: string) {
  const lang = LANGUAGES.find((l) => l.id === id);
  if (!lang) throw new Error(`no client language "${id}" (src/clients.ts)`);
  return lang;
}
