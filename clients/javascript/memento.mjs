// memento.mjs — a complete JSMemento client in plain JavaScript (Node ≥ 22, no dependencies).
//
// It does three things, in this order:
//   1. push    one USER_LOGIN event for you (the OS user) and print its id and rendered line;
//   2. query   the last 10 events of user/<you>;
//   3. tail    the live stream of user/<you> for 10 seconds.
//
// Environment:
//   MEMENTO_API_KEY  your API key with the read and write scopes (required)
//   MEMENTO_URL      the API base, default https://service.stage.memento-service.org/memento
//
// Run:
//   MEMENTO_API_KEY=mk_… node memento.mjs

import { userInfo } from "node:os";

const DEFAULT_URL = "https://service.stage.memento-service.org/memento";
const BASE_URL = (process.env.MEMENTO_URL || DEFAULT_URL).replace(/\/+$/, "");
const API_KEY = process.env.MEMENTO_API_KEY;
const TAIL_SECONDS = 10;

class ApiError extends Error {}

/** POST a JSON body to the API and return the envelope's `data`; throws ApiError. */
async function post(path, body) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(`Cannot reach ${BASE_URL}: ${error.cause?.message ?? error.message}`);
  }
  const envelope = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = envelope.error?.message ?? response.statusText;
    throw new ApiError(`HTTP ${response.status}: ${message}`);
  }
  return envelope.data;
}

/** 1. Push one event; returns the stored event. */
async function push(user) {
  const event = await post("/events", {
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: user,
    actor_id: user,
    payload: { ip: "127.0.0.1", client: "javascript" },
  });
  console.log(`Pushed ${event.id}`);
  console.log(`  ${event.rendered}`);
  return event;
}

/** 2. The last 10 events of user/<user>, newest first. */
async function query(user) {
  const events = await post("/events/query", {
    filter: {
      and: [
        { field: "instance_type", op: "eq", value: "user" },
        { field: "instance_id", op: "eq", value: user },
      ],
    },
    limit: 10,
  });
  console.log(`\nLatest events of user/${user}:`);
  for (const event of events) {
    console.log(`  ${event.occurred_at}  ${event.event_type}  ${event.rendered ?? ""}`);
  }
}

/** 3. Print every new event of user/<user> for TAIL_SECONDS seconds. */
function tail(user) {
  const params = new URLSearchParams({ instance_type: "user", instance_id: user, locale: "en" });
  const url = `${BASE_URL.replace(/^http/, "ws")}/ws?${params}`;
  return new Promise((resolve, reject) => {
    // The key travels as a subprotocol; the server answers with `memento.v1`.
    const socket = new WebSocket(url, ["memento.v1", `bearer.${API_KEY}`]);
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      socket.close(1000);
      console.log("Done.");
      resolve();
    }, TAIL_SECONDS * 1000);
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(message.data);
      if (frame.kind === "memento.welcome") {
        console.log(`\nTailing user/${user} for ${TAIL_SECONDS} s …`);
      } else if (frame.kind === "memento.event.new") {
        console.log(`  ${frame.payload.rendered ?? frame.payload.event_type}`);
      }
      // anything else (memento.pong, …) is ignored
    });
    socket.addEventListener("error", () => {
      if (finished) return;
      clearTimeout(timer);
      reject(new ApiError(`Tail: cannot open the stream at ${url.split("?")[0]}`));
    });
    socket.addEventListener("close", (event) => {
      if (finished) return;
      clearTimeout(timer);
      reject(new ApiError(`Tail: the server closed the stream (${event.code} ${event.reason})`));
    });
  });
}

/** The OS user name: the instance and actor of the event. */
function osUser() {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "anonymous";
  }
}

async function main() {
  if (!API_KEY) {
    console.error(
      "Set MEMENTO_API_KEY (create one at https://service.stage.memento-service.org/keys)",
    );
    process.exit(2);
  }
  const user = osUser();
  try {
    await push(user);
    await query(user);
    await tail(user);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

await main();
