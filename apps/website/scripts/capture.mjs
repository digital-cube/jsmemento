#!/usr/bin/env node
/**
 *   MEMENTO_API_KEY=mk_… npm run capture
 *
 * The requests and answers the home page shows ("One event, every way to read it" and "The
 * API"), recorded from a real memento instead of typed: one USER_LOGIN pushed while a /ws
 * connection listens for it, then read back as the entity's history in en and in sr and
 * through the Filter DSL, one refused push (the error envelope), and one UDC `list` of
 * `cpu_load`. Each request body is a file of
 * snippets/wire/ (`*.json`); each answer is written next to it (`*.out.json`, `ws.out.txt`: the
 * frames in arrival order, a blank line between two), indented, an object that fits in 72
 * columns on one line, every UUID shortened to its first eight characters. Re-run it when the
 * API's answers change; the site imports the files `?raw`, so a build after it picks them up.
 *
 * MEMENTO_API_KEY  a key with `read` and `write` (create one at {SERVICE_URL}/keys)
 * MEMENTO_URL      the API base the events go to (default {SERVICE_URL}/memento)
 * UDC_URL          the API base the `cpu_load` list is read from (default {EXAMPLE_URL}/memento,
 *                  the examples instance, whose CPU monitor fills it), with the read-only demo
 *                  key that instance hands out at /api/demo
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_URL, SERVICE_URL } from "../src/site.mjs";

const WIRE = join(dirname(fileURLToPath(import.meta.url)), "..", "snippets", "wire");
const BASE = (process.env.MEMENTO_URL || `${SERVICE_URL}/memento`).replace(/\/+$/, "");
const UDC_BASE = (process.env.UDC_URL || `${EXAMPLE_URL}/memento`).replace(/\/+$/, "");
const KEY = process.env.MEMENTO_API_KEY;
if (!KEY) {
  console.error(`Set MEMENTO_API_KEY (a read + write key: ${SERVICE_URL}/keys)`);
  process.exit(2);
}

const read = (name) => JSON.parse(readFileSync(join(WIRE, name), "utf8"));
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const shorten = (text) => text.replace(UUID, "$1…");
/** JSON indented by two, but an object or array that fits in WIDTH columns stays on one line. */
const WIDTH = 72;
const flat = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return value.length ? `[${value.map(flat).join(", ")}]` : "[]";
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${flat(v)}`).join(", ")} }`;
};
/** `used`: the columns already taken on the line before the value (indent, key). */
const compact = (value, indent = "", used = indent.length) => {
  const line = flat(value);
  if (value === null || typeof value !== "object" || used + line.length <= WIDTH) return line;
  const inner = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((v) => inner + compact(v, inner))
    : Object.entries(value).map(([k, v]) => {
        const key = `${inner}${JSON.stringify(k)}: `;
        return key + compact(v, inner, key.length);
      });
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")}\n${indent}${close}`;
};
const write = (name, value) => {
  const text =
    typeof value === "string"
      ? shorten(value)
      : compact(JSON.parse(shorten(JSON.stringify(value))));
  writeFileSync(join(WIRE, name), `${text}\n`);
  console.log(`snippets/wire/${name}`);
};

async function call(base, key, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false || String(json.kind).endsWith(".err")) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const push = read("push.json");
const entity = `/entities/${push.instance_type}/${push.instance_id}/events`;

// 1. A /ws connection for this one entity, then the push it should see.
const wsUrl = `${BASE.replace(/^http/, "ws")}/ws?instance_type=${push.instance_type}&instance_id=${push.instance_id}`;
const frames = [];
const socket = new WebSocket(wsUrl, ["memento.v1", `bearer.${KEY}`]);
const welcomed = new Promise((resolve, reject) => {
  socket.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)));
  socket.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data));
    frames.push(frame);
    if (frame.kind === "memento.welcome") resolve(undefined);
  });
});
await welcomed;
const pushed = await call(BASE, KEY, "POST", "/events", push);
write("push.out.json", pushed);
for (let i = 0; i < 50 && !frames.some((f) => f.kind === "memento.event.new"); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
socket.close();
const event = frames.find((f) => f.kind === "memento.event.new");
if (!event) throw new Error("the stream never delivered the pushed event");
// The frames in the order they arrived, a blank line between two.
write(
  "ws.out.txt",
  [frames.find((f) => f.kind === "memento.welcome"), event]
    .map((f) => compact(JSON.parse(shorten(JSON.stringify(f)))))
    .join("\n\n"),
);

// 2. The entity's history, newest first: in the default locale and in Serbian.
write("entity.out.json", await call(BASE, KEY, "GET", `${entity}?limit=1`));
write("entity-sr.out.json", await call(BASE, KEY, "GET", `${entity}?limit=1&locale=sr`));

// 3. The same events through the Filter DSL.
write("query.out.json", await call(BASE, KEY, "POST", "/events/query", read("query.json")));

// 4. The error envelope: an event_type that is not SCREAMING_SNAKE_CASE (422).
const refused = await fetch(`${BASE}/events`, {
  method: "POST",
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: readFileSync(join(WIRE, "error.json"), "utf8"),
});
if (refused.status !== 422)
  throw new Error(`POST /events error.json: HTTP ${refused.status}, not 422`);
write("error.out.json", await refused.json());

// 5. UDC: two rows of cpu_load from the examples instance, with its public read-only key.
const demo = await (await fetch(`${UDC_BASE}/api/demo`)).json();
if (!demo.ok) throw new Error(`${UDC_BASE}/api/demo: ${JSON.stringify(demo)}`);
write(
  "udc-list.out.json",
  await call(UDC_BASE, demo.data.api_key, "POST", "/udc/list", read("udc-list.json")),
);
