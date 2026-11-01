# Client programs

One complete program per language that talks to the JSMemento API with nothing but the
language's usual HTTP (and WebSocket) client. The service site offers them for download on its
`/clients` page; put your API key into the environment and run one.

Every program does the same three steps, in this order, with the same event:

1. **push** one `USER_LOGIN` event — `instance_type: "user"`, `instance_id` and `actor_id` your
   OS user name, `payload: {ip: "127.0.0.1", client: "<language>"}` — and print its id and
   rendered line (`User igor logged in from 127.0.0.1.`);
2. **query** the last 10 events of `user/<you>` (`POST /events/query`) and print
   `occurred_at  event_type  rendered` per line;
3. **tail** the live stream (`GET /ws?instance_type=user&instance_id=<you>`) for 10 seconds and
   print each event's rendered line — where the language has it; the others print one line
   saying tail is not in this sample.

| dir | files | HTTP / WebSocket | tail | run |
| --- | --- | --- | --- | --- |
| [`javascript`](javascript) | `memento.mjs` | global `fetch`, global `WebSocket` (Node ≥ 22) | yes | `node memento.mjs` |
| [`typescript`](typescript) | `memento.ts`, `package.json` | the same; `tsx` the only dependency | yes | `npx tsx memento.ts` |
| [`python`](python) | `memento.py` | `urllib.request`; `websockets` when importable | yes, with `websockets` | `python3 memento.py` |
| [`php`](php) | `memento.php` | the `curl` extension | no | `php memento.php` |
| [`java`](java) | `Memento.java` | `java.net.http.HttpClient` and its `WebSocket` (Java 21) | yes | `java Memento.java` |
| [`rust`](rust) | `Cargo.toml`, `Cargo.lock`, `src/main.rs` | `ureq`, `serde_json`, `tungstenite` (+ `native-tls`) | yes | `cargo run` |
| [`golang`](golang) | `main.go`, `go.mod`, `go.sum` | `net/http`, `encoding/json`, `github.com/coder/websocket` | yes | `go run .` |
| [`cpp`](cpp) | `memento.cpp`, `CMakeLists.txt` | `libcurl`, JSON built and parsed by hand | no | `cmake -B build && cmake --build build && ./build/memento` |

## Environment

| variable | |
| --- | --- |
| `MEMENTO_API_KEY` | a key with the `read` and `write` scopes (required) |
| `MEMENTO_URL` | the API base; default `https://service.stage.memento-service.org/memento` |

No key, URL or secret is in any file. Without `MEMENTO_API_KEY` every program prints
`Set MEMENTO_API_KEY (create one at https://service.stage.memento-service.org/keys)` and exits
with code 2; an HTTP error prints the status and the server's `error.message`
(`HTTP 401: invalid or expired API key`, `HTTP 429: this API key wrote its daily limit …`) and
exits with 1.

## Checks

[`check.sh`](check.sh) runs a program against a local server, and
[`.github/workflows/clients.yml`](../.github/workflows/clients.yml) does it for all eight on
every change:

```bash
pnpm turbo run build --filter=@memento/server --filter=@memento/cli
DATABASE_URL=postgresql://jsmemento:jsmemento@localhost:5432/jsmemento clients/check.sh stack
export MEMENTO_URL=http://127.0.0.1:8000/memento MEMENTO_API_KEY=mk_…   # what `stack` printed
clients/check.sh run python        # no key → exit 2; wrong key → exit 1 + 401; then the real run
clients/check.sh stop
```

`run` asserts that the query lists the pushed event first and, for the languages with tail,
that tail printed an event `check.sh` pushed while it was live. `CLIENT_CMD` replaces the
language's run command, e.g. to use a toolchain in a container (see the top of `check.sh`).
