#!/usr/bin/env node
/**
 * The whole test suite in one command, with ONE coverage report — what `thilo.toml` [testing]
 * runs (through `tools/test-full.sh`) and what `pnpm test:full` runs by hand.
 *
 *   1. resolves the databases (the environment, then `.env`, then the defaults of
 *      `@memento/server`'s config, which `.env.example` repeats) and REFUSES (exit 2) a
 *      `TEST_DATABASE_URL` that is not a PostgreSQL test database: the suites TRUNCATE it;
 *   2. checks that this PostgreSQL and Redis answer (exit 2 with a sentence when they do not);
 *   3. `turbo run test:cov --continue`: every package with coverage, `@memento/server` and
 *      `@memento/cli` on both databases (their Vitest projects `server` / `server-sqlite`,
 *      `cli` / `cli-sqlite`, in one Vitest run each, so one coverage map per package);
 *   4. `turbo run test:e2e`: the built server ×2 over HTTP and WebSocket (skip: `--no-e2e`);
 *   5. merges every workspace's `coverage/coverage-final.json` (`packages/*`, `apps/*`) into
 *      `coverage/coverage.json` at the repository root, in coverage.py's JSON format
 *      (`format = "coverage-py-json"`, the only one the thilo runner reads), plus a `packages`
 *      key with each workspace's own totals.
 *
 * Exit status: 0 only when every step passed (a package's coverage threshold failing fails the
 * step, as in CI); the coverage file is written either way, so a red run still carries its
 * numbers. 2: the run did not start (a refused or unreachable database, no `pnpm install`).
 *
 * Workers: `MEMENTO_TEST_WORKERS` (`auto`, `off`, or N), else a thilo test ticket's `workers`,
 * which arrives as pytest-xdist's `-n N` in `PYTEST_ADDOPTS`, else 2. It becomes Vitest's
 * `--maxWorkers=N` on every package (`-n 0` / `off` → one worker, no file parallelism;
 * `auto` → Vitest's default, one per core — a lot of jsdom on a big machine). Turbo runs
 * `MEMENTO_TEST_CONCURRENCY` packages at a time (default 2). Both defaults are low on purpose:
 * a full run was once killed for memory (exit 137) on a shared machine.
 *
 *   node tools/test-full.mjs              # everything
 *   node tools/test-full.mjs --no-e2e     # unit suites and coverage only
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { constants } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(new URL("..", import.meta.url).pathname);
const OUT = "coverage/coverage.json";
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--no-e2e");
if (unknown.length > 0) {
  const help = unknown.includes("--help") || unknown.includes("-h");
  if (!help) console.error(`test-full: unknown argument(s): ${unknown.join(" ")}`);
  console.error(
    "usage: node tools/test-full.mjs [--no-e2e]   (docs/CONTRIBUTING.md § The full suite)",
  );
  process.exit(help ? 0 : 2);
}
const e2e = !args.has("--no-e2e") && process.env.MEMENTO_TEST_E2E !== "0";

/** The defaults of `packages/server/src/config.ts` (and `.env.example`). */
const DEFAULTS = {
  DATABASE_URL: "postgresql://jsmemento:jsmemento@localhost:5432/jsmemento",
  TEST_DATABASE_URL: "postgresql://jsmemento:jsmemento@localhost:5432/jsmemento_test",
  REDIS_URL: "redis://localhost:6379/0",
};

/**
 * The URLs the suites read: the environment, then `.env`, then DEFAULTS. Only these are taken
 * from `.env` — the rest of it (ports of a deployment, mail keys) is none of the tests' business.
 */
function resolveUrls() {
  const path = join(root, ".env");
  const file = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  const pick = (name) => process.env[name] || file[name] || DEFAULTS[name] || "";
  return {
    DATABASE_URL: pick("DATABASE_URL"),
    TEST_DATABASE_URL: pick("TEST_DATABASE_URL"),
    REDIS_URL: pick("REDIS_URL"),
    MEMENTO_E2E_DATABASE_URL: pick("MEMENTO_E2E_DATABASE_URL"),
  };
}

const isPostgres = (url) => /^postgres(ql)?:\/\//.test(url);

/** `host:port/database` of a PostgreSQL URL — what decides which data a TRUNCATE hits. */
function target(url) {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 5432}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
}

/** A database name that says it is for tests: `jsmemento_test`, `test_memento`, `memento-test2`. */
const looksLikeTest = (name) => /(^|[_-])test([_-]|\d*$)/i.test(name);

/** Refuses (exit 2) any URL that would let a suite truncate or migrate a database not for tests. */
function guard(urls) {
  const problems = [];
  const test = urls.TEST_DATABASE_URL;
  if (!isPostgres(test)) {
    problems.push(
      `TEST_DATABASE_URL must be a PostgreSQL URL here (the SQLite projects make their own file), not ${JSON.stringify(test)}`,
    );
  } else {
    const where = target(test);
    const name = where.slice(where.indexOf("/") + 1);
    if (!looksLikeTest(name)) {
      problems.push(
        `TEST_DATABASE_URL points at the database "${name}" (${where}), whose name does not say it is a test database (e.g. jsmemento_test) — the suites TRUNCATE it`,
      );
    }
    if (isPostgres(urls.DATABASE_URL) && target(urls.DATABASE_URL) === where) {
      problems.push(`TEST_DATABASE_URL and DATABASE_URL are the same database (${where})`);
    }
    const e2eDb = urls.MEMENTO_E2E_DATABASE_URL;
    if (e2eDb && (!isPostgres(e2eDb) || target(e2eDb) !== where)) {
      problems.push(
        `MEMENTO_E2E_DATABASE_URL (${isPostgres(e2eDb) ? target(e2eDb) : e2eDb}) is not TEST_DATABASE_URL (${where}); the full suite runs E2E on the test database only`,
      );
    }
  }
  if (problems.length === 0) return;
  console.error("test-full: refusing to run — the database settings are not safe for tests:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("  Set TEST_DATABASE_URL (environment or .env) to the compose.yaml test database,");
  console.error("  e.g. postgresql://jsmemento:jsmemento@localhost:5432/jsmemento_test.");
  process.exit(2);
}

/** `true` when something accepts a TCP connection at `host:port` within `ms`. */
function reachable(host, port, ms = 3000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(ms, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The services the suites need, each checked; a sentence per one that does not answer. */
async function preflight(urls) {
  const needed = [
    ["PostgreSQL", "TEST_DATABASE_URL", 5432],
    ["Redis", "REDIS_URL", 6379],
  ];
  const problems = [];
  for (const [what, name, defaultPort] of needed) {
    const url = new URL(urls[name]);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || defaultPort);
    if (!(await reachable(host, port))) {
      problems.push(`${what} is not reachable at ${url.hostname}:${port} (${name})`);
    }
  }
  if (problems.length === 0) return;
  console.error("test-full: the test suites need PostgreSQL and Redis (compose.yaml).");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("  Start them with `pnpm db:up` (docker compose up -d postgres redis), or point");
  console.error("  TEST_DATABASE_URL / REDIS_URL (environment or .env) at the ones you run.");
  process.exit(2);
}

/** `auto` | `off` | `"N"` | `null` (say nothing) from MEMENTO_TEST_WORKERS or PYTEST_ADDOPTS' `-n`. */
function requestedWorkers() {
  const own = (process.env.MEMENTO_TEST_WORKERS ?? "").trim().toLowerCase();
  if (own) return own === "0" ? "off" : own;
  const tokens = (process.env.PYTEST_ADDOPTS ?? "").trim().split(/\s+/);
  let value = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-n" || t === "--numprocesses") value = tokens[++i] ?? null;
    else if (t.startsWith("--numprocesses=")) value = t.slice("--numprocesses=".length);
    else if (/^-n\S+$/.test(t)) value = t.slice(2);
  }
  if (value === null) return null;
  value = value.toLowerCase();
  return value === "0" ? "off" : value;
}

const DEFAULT_WORKERS = "2";

/** Vitest arguments for a worker request; an unreadable one falls back to the default. */
function vitestWorkerArgs(workers) {
  if (workers === "auto" || workers === "logical") return [];
  if (workers === "off") return ["--maxWorkers=1", "--no-file-parallelism"];
  if (/^[1-9]\d*$/.test(workers)) return [`--maxWorkers=${workers}`];
  console.warn(`test-full: ignoring the worker count ${JSON.stringify(workers)}`);
  return [`--maxWorkers=${DEFAULT_WORKERS}`];
}

function turboConcurrency() {
  const value = (process.env.MEMENTO_TEST_CONCURRENCY ?? "").trim();
  if (/^[1-9]\d*$/.test(value)) return value;
  if (value) console.warn(`test-full: ignoring MEMENTO_TEST_CONCURRENCY=${JSON.stringify(value)}`);
  return "2";
}

/** Runs a command from the repository root, output passed through; its exit status. */
function run(command, argv, env) {
  console.log(`\n$ ${[relative(root, command) || command, ...argv].join(" ")}`);
  const result = spawnSync(command, argv, { cwd: root, stdio: "inherit", env });
  if (result.error) {
    console.error(`test-full: cannot run ${command}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 128 + (constants.signals[result.signal] ?? 0);
}

/**
 * One istanbul file record → its lines: `line → hits`, the way istanbul itself counts lines
 * (a line is the highest count of the statements that start on it).
 */
function lineHits(record) {
  const lines = new Map();
  for (const [id, loc] of Object.entries(record.statementMap ?? {})) {
    const line = loc.start.line;
    const hits = record.s?.[id] ?? 0;
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  }
  return lines;
}

const pct = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);

/** The coverage.py-shaped summary of a set of executed and missing lines. */
function summary(executed, missing) {
  const total = executed + missing;
  const percent = pct(executed, total);
  return {
    covered_lines: executed,
    num_statements: total,
    percent_covered: percent,
    percent_covered_display: String(Math.round(percent)),
    missing_lines: missing,
    excluded_lines: 0,
  };
}

/** The workspace directories (`pnpm-workspace.yaml`: `packages/*`, `apps/*`), relative. */
function workspaces() {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, group, d.name, "package.json")))
      .map((d) => `${group}/${d.name}`)
      .sort(),
  );
}

const manifest = (ws) => JSON.parse(readFileSync(join(root, ws, "package.json"), "utf8"));

/**
 * Every workspace's `coverage-final.json`, merged into one coverage.py JSON document. A file is
 * counted once: Vitest already merges a package's projects (PostgreSQL and SQLite) into one
 * map, and a file that two workspaces measure keeps, per line, the higher hit count.
 */
function mergeCoverage() {
  /** path → { lines: Map<line, hits>, ws } */
  const byFile = new Map();
  const istanbulTotals = {};
  const missingReports = [];
  for (const ws of workspaces()) {
    const dir = join(root, ws, "coverage");
    const final = join(dir, "coverage-final.json");
    if (!existsSync(final)) {
      if (manifest(ws).scripts?.["test:cov"]) missingReports.push(ws);
      continue;
    }
    for (const record of Object.values(JSON.parse(readFileSync(final, "utf8")))) {
      const path = relative(root, record.path);
      const entry = byFile.get(path) ?? { lines: new Map(), ws };
      for (const [line, hits] of lineHits(record)) {
        entry.lines.set(line, Math.max(entry.lines.get(line) ?? 0, hits));
      }
      byFile.set(path, entry);
    }
    const istanbulSummary = join(dir, "coverage-summary.json");
    const total = existsSync(istanbulSummary)
      ? JSON.parse(readFileSync(istanbulSummary, "utf8")).total
      : null;
    // Vitest's own numbers (what CI's ≥ 80 % threshold reads), statements counted by AST.
    istanbulTotals[ws] = total && {
      lines: total.lines.pct,
      statements: total.statements.pct,
      functions: total.functions.pct,
      branches: total.branches.pct,
    };
  }

  const files = {};
  const perWs = {};
  for (const path of [...byFile.keys()].sort()) {
    const { lines, ws } = byFile.get(path);
    const hit = [...lines].filter(([, n]) => n > 0).map(([l]) => l);
    const miss = [...lines].filter(([, n]) => n === 0).map(([l]) => l);
    hit.sort((a, b) => a - b);
    miss.sort((a, b) => a - b);
    files[path] = {
      executed_lines: hit,
      summary: summary(hit.length, miss.length),
      missing_lines: miss,
      excluded_lines: [],
    };
    perWs[ws] ??= { executed: 0, missing: 0 };
    const acc = perWs[ws];
    acc.executed += hit.length;
    acc.missing += miss.length;
  }
  const packages = {};
  for (const ws of Object.keys(istanbulTotals)) {
    const { executed = 0, missing = 0 } = perWs[ws] ?? {};
    packages[manifest(ws).name ?? ws] = {
      ...summary(executed, missing),
      istanbul: istanbulTotals[ws],
    };
  }
  const covered = Object.values(files).reduce((n, f) => n + f.summary.covered_lines, 0);
  const all = Object.values(files).reduce((n, f) => n + f.summary.num_statements, 0);
  return {
    report: {
      meta: {
        format: 3,
        version: "jsmemento tools/test-full.mjs (from Vitest/istanbul line coverage)",
        timestamp: new Date().toISOString(),
        branch_coverage: false,
        show_contexts: false,
      },
      files,
      totals: summary(covered, all - covered),
      packages,
    },
    missingReports,
  };
}

function printTable(report) {
  console.log("\ncoverage (lines)               covered / lines     %");
  for (const [name, p] of Object.entries(report.packages)) {
    const nums = `${p.covered_lines} / ${p.num_statements}`.padStart(16);
    console.log(`  ${name.padEnd(26)} ${nums}  ${p.percent_covered.toFixed(1).padStart(5)}`);
  }
  const t = report.totals;
  const nums = `${t.covered_lines} / ${t.num_statements}`.padStart(16);
  console.log(`  ${"TOTAL".padEnd(26)} ${nums}  ${t.percent_covered.toFixed(1).padStart(5)}`);
  console.log(`\nwritten: ${OUT}`);
}

const urls = resolveUrls();
guard(urls);
await preflight(urls);
console.log(
  `test-full: PostgreSQL ${target(urls.TEST_DATABASE_URL)} (TEST_DATABASE_URL), Redis ${new URL(urls.REDIS_URL).host}`,
);

/**
 * What every suite sees. The only PostgreSQL of this run is the test database — DATABASE_URL
 * too, so nothing that reads the server's own URL can reach other data. MEMENTO_E2E_URL is
 * dropped: E2E tests this checkout's build, not a server running somewhere.
 * MEMENTO_TEST_DIALECT is dropped: both databases, always.
 */
const env = {
  ...process.env,
  TEST_DATABASE_URL: urls.TEST_DATABASE_URL,
  DATABASE_URL: urls.TEST_DATABASE_URL,
  MEMENTO_E2E_DATABASE_URL: urls.TEST_DATABASE_URL,
  REDIS_URL: urls.REDIS_URL,
};
delete env.MEMENTO_E2E_URL;
delete env.MEMENTO_TEST_DIALECT;

const workers = requestedWorkers() ?? DEFAULT_WORKERS;
const workerArgs = vitestWorkerArgs(workers);
const concurrency = turboConcurrency();
console.log(
  `test-full: workers ${workers} → ${workerArgs.join(" ") || "Vitest's default"}, ${concurrency} package(s) at a time`,
);

// Stale reports must not pass for this run's: a package that fails to build writes none.
rmSync(join(root, OUT), { force: true });
for (const ws of workspaces()) rmSync(join(root, ws, "coverage"), { recursive: true, force: true });

const turbo = join(root, "node_modules", ".bin", "turbo");
if (!existsSync(turbo)) {
  console.error("test-full: node_modules/.bin/turbo is missing — run `pnpm install` first.");
  process.exit(2);
}
const statuses = [];
statuses.push(
  run(
    turbo,
    [
      "run",
      "test:cov",
      "--continue",
      `--concurrency=${concurrency}`,
      ...(workerArgs.length ? ["--", ...workerArgs] : []),
    ],
    env,
  ),
);
if (e2e) statuses.push(run(turbo, ["run", "test:e2e", `--concurrency=${concurrency}`], env));

const { report, missingReports } = mergeCoverage();
mkdirSync(join(root, "coverage"), { recursive: true });
writeFileSync(join(root, OUT), `${JSON.stringify(report)}\n`);
printTable(report);
for (const ws of missingReports) {
  console.error(`test-full: ${ws} has a test:cov script but wrote no coverage-final.json`);
}

const failed = statuses.find((s) => s !== 0);
if (failed !== undefined) {
  console.error(`\ntest-full: FAILED (exit ${failed}) — see the output above.`);
  process.exit(failed);
}
if (missingReports.length > 0) {
  console.error("\ntest-full: FAILED — a package's coverage is missing.");
  process.exit(1);
}
console.log("\ntest-full: all suites passed.");
