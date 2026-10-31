#!/usr/bin/env node
import {
  connect,
  type DatabaseHandle,
  type EventPublisher,
  loadConfig,
  RedisPublisher,
} from "@memento/server";
import { runCli } from "./program.js";
import { oraSpinner } from "./ui.js";

const config = loadConfig();
let handle: DatabaseHandle | undefined;
let publisher: EventPublisher | undefined;
const db = () => {
  handle ??= connect(config.databaseUrl, { max: 2 });
  return handle.db;
};
const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const color = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
// Ctrl+C ends `memento tail` cleanly; elsewhere it interrupts as usual.
const interrupted = new AbortController();
process.once("SIGINT", () => interrupted.abort());

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    db,
    defaultLocale: config.defaultLocale,
    databaseUrl: config.databaseUrl,
    color,
    interactive: tty,
    spinner: process.stderr.isTTY ? oraSpinner : null,
    signal: interrupted.signal,
    // Messages sent from the CLI reach real-time subscribers like any other event.
    ...(config.redisUrl
      ? {
          publisher: () =>
            (publisher ??= new RedisPublisher(
              config.redisUrl as string,
              config.redisChannelPrefix,
            )),
        }
      : {}),
  });
} finally {
  await publisher?.close().catch(() => {});
  await handle?.close().catch(() => {});
}
