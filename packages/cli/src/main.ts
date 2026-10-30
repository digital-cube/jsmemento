#!/usr/bin/env node
import { connect, type DatabaseHandle, loadConfig } from "@memento/server";
import { runCli } from "./program.js";

let handle: DatabaseHandle | undefined;
const db = () => {
  handle ??= connect(loadConfig().databaseUrl, { max: 2 });
  return handle.db;
};

try {
  process.exitCode = await runCli(process.argv.slice(2), { db });
} finally {
  await handle?.close();
}
