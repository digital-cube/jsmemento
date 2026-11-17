#!/usr/bin/env node
/**
 *   node scripts/check-hosts.mjs [dist]      (the last step of `npm run build`)
 *
 * A build for production must not send anybody to stage: when this build's SERVICE_URL
 * (src/site.mjs) is not a stage host, no file of the built site may name a `service.stage.`
 * host — the quick start, a client program, a snippet or a prose line that still spells
 * stage's service fails the build here, with the file and the line. A stage build
 * (SERVICE_URL on `*.stage.*`) may name stage, so it is only reported.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_URL } from "../src/site.mjs";

/** What a production build may not name. */
export const STAGE_SERVICE = /\bservice\.stage\.[a-z0-9.-]+/i;

/** Is `url` a stage host (`https://service.stage.memento-service.org`)? */
export const isStage = (url) => /(^|\.)stage\./i.test(new URL(url).hostname);

const TEXT = /\.(html|xml|txt|json|js|mjs|css|svg|md)$/i;

/** Every `<file>:<line>: <host>` of `dir` naming a stage service, sorted by path. */
export function stageMentions(dir) {
  const found = [];
  const walk = (at) => {
    for (const e of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(at, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && TEXT.test(e.name)) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const m = STAGE_SERVICE.exec(line);
            if (m) found.push(`${relative(dir, path)}:${i + 1}: ${m[0]}`);
          });
      }
    }
  };
  walk(dir);
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const found = stageMentions(dist);
  if (isStage(SERVICE_URL)) {
    console.log(
      `check-hosts: stage build (SERVICE_URL=${SERVICE_URL}), ${found.length} stage mention(s) allowed`,
    );
  } else if (found.length) {
    console.error(
      `check-hosts: SERVICE_URL=${SERVICE_URL}, but the built site names stage's service:\n  ` +
        found.join("\n  ") +
        "\nThe client programs and snippets name https://service.memento-service.org (src/site.mjs" +
        " swaps it for SERVICE_URL); a page links {SERVICE_URL}.",
    );
    process.exit(1);
  } else {
    console.log(`check-hosts: SERVICE_URL=${SERVICE_URL}, no page names a service.stage. host`);
  }
}
