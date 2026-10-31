import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@memento/server";
import type { TestProject } from "vitest/node";

/**
 * Brings up the stack the E2E suites talk to and hands them its URLs.
 *
 * - `MEMENTO_E2E_URL` set (e.g. `http://localhost:3000/memento`, the docker-compose stack):
 *   nothing is started, every suite talks to that server.
 * - otherwise two processes of the built server (`packages/server/dist/server.js`) are started
 *   on free ports, against the same PostgreSQL and Redis. Suites push to one and stream from
 *   the other, so an event can only arrive through Redis.
 *
 * Tenants and keys are created directly in the database at `MEMENTO_E2E_DATABASE_URL`
 * (default `TEST_DATABASE_URL`), which must be the database the server uses.
 */

const SERVER_ENTRY = fileURLToPath(new URL("../../server/dist/server.js", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    /** API base URLs (`…/memento`); one entry when the stack is external. */
    servers: string[];
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitHealthy(base: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${base} not healthy after 30 s:\n${output.join("")}`);
}

async function startServer(databaseUrl: string, redisUrl: string): Promise<[string, ChildProcess]> {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOG_LEVEL: process.env.MEMENTO_E2E_LOG_LEVEL ?? "warn",
      MEMENTO_RECORD_CANDIDATES: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output.push(String(chunk));
      if (process.env.MEMENTO_E2E_LOG_LEVEL) process.stderr.write(chunk);
    });
  }
  const base = `http://127.0.0.1:${port}/memento`;
  await waitHealthy(base, child, output);
  return [base, child];
}

export default async function setup({ provide }: TestProject) {
  const config = loadConfig();
  const databaseUrl = process.env.MEMENTO_E2E_DATABASE_URL || config.testDatabaseUrl;
  provide("databaseUrl", databaseUrl);

  const external = process.env.MEMENTO_E2E_URL;
  if (external) {
    const base = external.replace(/\/+$/, "");
    const response = await fetch(`${base}/api/health`).catch((error: unknown) => {
      throw new Error(`MEMENTO_E2E_URL ${base} is not reachable: ${String(error)}`);
    });
    if (!response.ok) throw new Error(`${base}/api/health answered ${response.status}`);
    provide("servers", [base]);
    return;
  }

  const redisUrl = config.redisUrl ?? "redis://localhost:6379/0";
  const children: ChildProcess[] = [];
  const stop = async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill("SIGTERM");
          }),
      ),
    );
  };
  const servers: string[] = [];
  try {
    // One after the other: each process applies the migrations on start.
    for (let i = 0; i < 2; i++) {
      const [base, child] = await startServer(databaseUrl, redisUrl);
      children.push(child);
      servers.push(base);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  provide("servers", servers);
  return stop;
}
