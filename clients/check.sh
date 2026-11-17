#!/usr/bin/env bash
# clients/check.sh — runs the client programs against a local JSMemento server and checks
# what they print. Used by .github/workflows/clients.yml; works the same on a laptop.
#
#   clients/check.sh stack            start the built server (packages/server/dist) on $PORT
#                                     against $DATABASE_URL, create a tenant and a read,write
#                                     key with the CLI, print MEMENTO_URL / MEMENTO_API_KEY
#                                     (and append them to $GITHUB_ENV on GitHub Actions)
#   clients/check.sh run <lang>       with MEMENTO_URL / MEMENTO_API_KEY set: run the program of
#                                     clients/<lang> three times — without a key (exit 2), with
#                                     a wrong key (exit 1, HTTP 401), with the key (exit 0) —
#                                     and assert the query step lists the pushed event and, for
#                                     the languages with tail, that tail printed an event pushed
#                                     while it was live
#   clients/check.sh stop             stop the server `stack` started
#
# `run` executes the language's usual command in clients/<lang>; set CLIENT_CMD to run it
# another way, e.g. in a container:
#   CLIENT_CMD='podman run --rm --network host -e MEMENTO_URL -e MEMENTO_API_KEY \
#     -v "$PWD":/w -w /w docker.io/library/golang:1.24 go run .' clients/check.sh run golang
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${CLIENTS_STATE_DIR:-${TMPDIR:-/tmp}/memento-clients}"
mkdir -p "$STATE"

fail() { echo "FAIL: $*" >&2; exit 1; }

default_cmd() {
  case "$1" in
    javascript) echo "node memento.mjs" ;;
    typescript) echo "npx --no-install tsx memento.ts" ;;
    python) echo "python3 memento.py" ;;
    php) echo "php memento.php" ;;
    java) echo "java Memento.java" ;;
    rust) echo "cargo run --quiet" ;;
    golang) echo "go build -o memento-client . && ./memento-client" ;; # go run turns every exit code into 1
    cpp) echo "./build/memento" ;;
    *) fail "unknown language: $1" ;;
  esac
}

has_tail() {
  case "$1" in javascript | typescript | python | java | rust | golang) return 0 ;; esac
  return 1
}

stack() {
  : "${DATABASE_URL:?set DATABASE_URL to the PostgreSQL the server should use}"
  local port="${PORT:-8000}" base
  base="http://127.0.0.1:${port}/memento"
  PORT="$port" HOST=127.0.0.1 LOG_LEVEL="${LOG_LEVEL:-warn}" MEMENTO_RECORD_CANDIDATES=false \
    nohup node "$ROOT/packages/server/dist/server.js" >"$STATE/server.log" 2>&1 &
  echo $! >"$STATE/server.pid"
  for _ in $(seq 1 150); do
    curl -fsS "$base/api/health" >/dev/null 2>&1 && break
    kill -0 "$(cat "$STATE/server.pid")" 2>/dev/null || { cat "$STATE/server.log"; fail "server exited"; }
    sleep 0.2
  done
  curl -fsS "$base/api/health" >/dev/null || { cat "$STATE/server.log"; fail "server not healthy"; }

  local cli=(node "$ROOT/packages/cli/dist/main.js") slug key
  slug="clients-$(date +%s)-$RANDOM"
  "${cli[@]}" create-tenant "$slug" --name "Client programs" >/dev/null
  key="$("${cli[@]}" --json create-key --tenant "$slug" --scopes read,write --name clients \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')"
  [[ "$key" == mk_* ]] || fail "could not create a key"
  echo "MEMENTO_URL=$base"
  echo "MEMENTO_API_KEY=$key"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "::add-mask::$key"
    { echo "MEMENTO_URL=$base"; echo "MEMENTO_API_KEY=$key"; } >>"$GITHUB_ENV"
  fi
}

stop() {
  [[ -f "$STATE/server.pid" ]] && kill "$(cat "$STATE/server.pid")" 2>/dev/null || true
  rm -f "$STATE/server.pid"
}

# Push one event the way the programs do, from outside, so tail has something to print.
push_from_outside() {
  local user="$1"
  curl -fsS -X POST "$MEMENTO_URL/events" \
    -H "Authorization: Bearer $MEMENTO_API_KEY" -H "Content-Type: application/json" \
    -d "{\"event_type\":\"USER_LOGIN\",\"instance_type\":\"user\",\"instance_id\":\"$user\",\"actor_id\":\"$user\",\"payload\":{\"ip\":\"127.0.0.2\",\"client\":\"check.sh\"}}" \
    >/dev/null
}

run() {
  local lang="$1" dir="$ROOT/clients/$1" cmd out code
  [[ -d "$dir" ]] || fail "no directory clients/$lang"
  : "${MEMENTO_URL:?}" "${MEMENTO_API_KEY:?}"
  cmd="${CLIENT_CMD:-$(default_cmd "$lang")}"
  out="$STATE/$lang.out"
  cd "$dir"

  echo "== $lang: without MEMENTO_API_KEY"
  code=0
  env -u MEMENTO_API_KEY timeout 120 bash -c "$cmd" >"$out" 2>&1 || code=$?
  cat "$out"
  [[ $code -eq 2 ]] || fail "$lang: expected exit code 2 without a key, got $code"
  grep -qF "Set MEMENTO_API_KEY (create one at https://service.memento-service.org/keys)" "$out" \
    || fail "$lang: no hint about MEMENTO_API_KEY"

  echo "== $lang: with a wrong key"
  code=0
  MEMENTO_API_KEY=mk_00000000_wrongwrongwrongwrongwrongwrongwr timeout 120 bash -c "$cmd" >"$out" 2>&1 || code=$?
  cat "$out"
  [[ $code -eq 1 ]] || fail "$lang: expected exit code 1 with a wrong key, got $code"
  grep -q "401" "$out" || fail "$lang: the 401 is not printed"

  echo "== $lang: push, query, tail"
  code=0
  : >"$out"
  timeout 120 bash -c "$cmd" >"$out" 2>&1 &
  local pid=$!
  if has_tail "$lang"; then
    # Once the program says it is tailing (it says so on the welcome), push one more event.
    local user=""
    for _ in $(seq 1 600); do
      user="$(sed -n 's|^Tailing user/\(.*\) for 10 s.*|\1|p' "$out")"
      [[ -n "$user" ]] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    [[ -n "$user" ]] && { sleep 1; push_from_outside "$user"; }
  fi
  wait "$pid" || code=$?
  cat "$out"
  [[ $code -eq 0 ]] || fail "$lang: exit code $code"

  local rendered
  rendered="$(awk '/^Pushed /{getline; sub(/^ +/, ""); print; exit}' "$out")"
  [[ "$rendered" == *"logged in from 127.0.0.1." ]] || fail "$lang: no rendered line after Pushed"
  # The newest event of the query is the one just pushed.
  awk '/^Latest events of /{getline; print; exit}' "$out" | grep -qF "  USER_LOGIN  $rendered" \
    || fail "$lang: the query does not list \"$rendered\" first"
  if has_tail "$lang"; then
    sed -n '/^Tailing /,$p' "$out" | grep -qF "logged in from 127.0.0.2." \
      || fail "$lang: tail did not print the event pushed while it was live"
    grep -q '^Done\.$' "$out" || fail "$lang: tail did not finish with Done."
  else
    grep -q "not in this sample" "$out" || fail "$lang: no note that tail is not in this sample"
  fi
  echo "OK: $lang"
}

case "${1:-}" in
  stack) stack ;;
  stop) stop ;;
  run) run "${2:?language}" ;;
  *) sed -n '2,20p' "$0" >&2; exit 64 ;;
esac
