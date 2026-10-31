#!/usr/bin/env node
import {
  connect,
  type DatabaseHandle,
  type EventPublisher,
  loadConfig,
  RedisPublisher,
} from "@memento/server";
import { runCli } from "./program.js";

const config = loadConfig();
let handle: DatabaseHandle | undefined;
let publisher: EventPublisher | undefined;
const db = () => {
  handle ??= connect(config.databaseUrl, { max: 2 });
  return handle.db;
};

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    db,
    defaultLocale: config.defaultLocale,
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
  await publisher?.close();
  await handle?.close();
}
