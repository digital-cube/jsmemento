#!/usr/bin/env bash
# Deploy the two server sites of JSMemento in production, natively on
# digitalcube-production-websites (no container: nothing on this VM is), on the VM's own
# PostgreSQL 18 and Redis:
#   https://examples.memento-service.org  memento-prod          127.0.0.1:8200  accounts off, demo key
#   https://service.memento-service.org   memento-service-prod  127.0.0.1:8201  accounts on
# plus the demo pushers memento-prod-cpu-monitor and memento-prod-simulator (tenant `demo`) and
# the daily memento-prod-retention.timer: docker-compose.yaml's services as systemd user units;
# and the daily memento-prod-backup.timer (deploy/examples/backup.sh: pg_dump of the database
# into $ROOT/backups, 7 daily + 4 weekly).
#
# Two checkouts of digital-cube/jsmemento under $ROOT, one clone (src/ is the repository,
# ops/ a `git worktree` of it):
#   src/  the APPLICATION, detached at a release tag (default v1.1.0, --ref for another), built
#         in place: pnpm (package.json's packageManager, through corepack) + the Dockerfile's
#         turbo filters. Production runs releases, not main.
#   ops/  the DEPLOYMENT files, detached at origin/main (--deploy-branch): this script, the
#         units and the vhosts. They are newer than the tag they deploy (v1.1.0 has no
#         deploy/examples/), so they cannot come from the application's checkout. The units and
#         the vhosts are symlinks into ops/.
# Each run: fetch -> check out both -> build src/ when its commit changed -> restart the units
# -> wait for both health checks -> checks through nginx on 127.0.0.1 and through the edge.
# The server applies pending migrations at start (under an advisory lock).
#
# --install does the one-time steps; it is idempotent (what exists is kept, what is missing is
# added): the PostgreSQL role and database `memento` with a generated password, .env (mode 600),
# the tenant `demo` with its read-only demo key and the two pushers' write keys, linger, the
# units, the vhosts. No secret is printed: they exist only in $ROOT/.env on the VM.
# --import-env adds NAME=value lines read from STDIN to .env (existing names are kept), e.g. the
# Brevo key copied from stage without it appearing on a command line or in a log.
#
# Works from any copy of the script (scp it to /tmp for the first run): it deploys what GitHub
# has, not the checkout it was started from. After the first run it lives in
# $ROOT/ops/deploy/examples/prod.sh.
#
# Usage: deploy/examples/prod.sh [--install] [--ref <tag|sha>] [--deploy-branch <name>] [--force]
#        deploy/examples/prod.sh --import-env < lines
set -euo pipefail

ROOT=/home/digital/sites/examples.memento-service.org
SRC="$ROOT/src"                    # the application, at --ref
OPS="$ROOT/ops"                    # the deployment files, at origin/<deploy branch>
ENV_FILE="$ROOT/.env"
CANDIDATES="$ROOT/data/candidates" # MEMENTO_CANDIDATES_DIR, outside src/ (git clean would empty it)
NODE_LINK="$ROOT/node"             # -> the nvm bin dir the units and the build run with
SHIMS="$ROOT/corepack"             # corepack's pnpm shim: the version package.json pins
MEMENTO_BIN="$ROOT/bin/memento"    # the CLI of src/ with this deployment's .env
BUILT="$ROOT/.built"               # the commit src/ was last built at
BACKUPS="$ROOT/backups"            # memento-<date>.dump, written by memento-prod-backup.service
REPO_URL="${REPO_URL:-https://github.com/digital-cube/jsmemento.git}"
DEFAULT_REF=v1.1.0
EXAMPLES_HOST=examples.memento-service.org
SERVICE_HOST=service.memento-service.org
EXAMPLES_PORT=8200
SERVICE_PORT=8201
EXPECTED_HOST=digitalcube-production-websites
EXPECTED_USER=digital
SERVERS=(memento-prod memento-service-prod)
PUSHERS=(memento-prod-cpu-monitor memento-prod-simulator)
RUNNING=("${SERVERS[@]}" "${PUSHERS[@]}")
UNIT_FILES=(memento-prod.service memento-service-prod.service memento-prod-cpu-monitor.service
  memento-prod-simulator.service memento-prod-retention.service memento-prod-retention.timer
  memento-prod-backup.service memento-prod-backup.timer)
TIMERS=(memento-prod-retention.timer memento-prod-backup.timer)
BACKUP_REL=deploy/examples/backup.sh # ExecStart= of memento-prod-backup.service, in ops/
UNIT_REL=deploy/examples/systemd
UNIT_DIR="$HOME/.config/systemd/user"
VHOST_REL=deploy/examples/nginx
VHOSTS=("$EXAMPLES_HOST" "$SERVICE_HOST")
DB_NAME=memento
DB_USER=memento
DEMO_TENANT=demo
# Redis is shared with vola (db 2) on this VM: memento takes db 3 for its keys (quota counters
# memento:quota:*, auth rate limits memento-auth-*), and a channel prefix of its own, because
# pub/sub channels ignore the database number.
REDIS_URL_DEFAULT="redis://127.0.0.1:6379/3"
REDIS_CHANNEL_PREFIX_DEFAULT="memento-prod:events"
# Set per process in the units (Environment=); EnvironmentFile= would override them, so .env
# must not name them.
PER_UNIT=(PORT MEMENTO_UI_DIR MEMENTO_MENU_PATH MEMENTO_ACCOUNTS MEMENTO_TRUST_PROXY MEMENTO_API_KEY)
# the Dockerfile's build: the CLI (and the server it depends on), the examples and service sites
FILTERS=(--filter=@jsmemento/cli... --filter=@jsmemento/examples --filter=@jsmemento/service)

usage() {
  cat <<EOF
Usage: deploy/examples/prod.sh [--install] [--ref <tag|sha>] [--deploy-branch <name>] [--force]
       deploy/examples/prod.sh --import-env < NAME=value lines

Runs ON $EXPECTED_HOST as $EXPECTED_USER. Deploys https://$EXAMPLES_HOST and
https://$SERVICE_HOST ($REPO_URL) into $ROOT:
  src/            the application at --ref (default $DEFAULT_REF), built in place
  ops/            deploy/ at origin/<deploy branch> (default main): this script, units, vhosts
  .env            mode 600: what every process shares (database, Redis, mail, quotas, keys)
  bin/memento     the memento CLI of src/ with .env loaded (users, keys, retention, --version)
  data/candidates MEMENTO_CANDIDATES_DIR
  backups/        memento-<date>.dump, daily (memento-prod-backup.timer, ops/$BACKUP_REL)
  node -> ~/.nvm/…/bin   the Node the build and the units run (newest installed v24)
  corepack/       corepack's pnpm shim, first on PATH (the pnpm package.json pins)
Units (systemctl --user, linked from ops/$UNIT_REL): ${SERVERS[0]} (127.0.0.1:$EXAMPLES_PORT),
${SERVERS[1]} (127.0.0.1:$SERVICE_PORT), ${PUSHERS[*]}, ${TIMERS[*]}.
Then: /memento/api/health 200 on both ports, through nginx on 127.0.0.1 with each Host
(the page titles, the demo key on $EXAMPLES_HOST only), and through the edge.

  --install              the one-time steps, harmless to repeat (what exists is kept):
                         PostgreSQL role and database $DB_NAME with a generated password;
                         .env (missing variables are added, existing ones never changed);
                         the tenant $DEMO_TENANT, its read-only demo key and the pushers' write
                         keys; loginctl enable-linger; link and enable the units and the timers;
                         the vhosts: a hand-written sites-available/<host> is kept as
                         <host>.coming-soon, sites-available/<host> -> ops/$VHOST_REL/<host>.conf,
                         sites-enabled/<host> -> sites-available/<host>, nginx -t, reload;
                         then the deploy
  --ref <tag|sha>        the application release to deploy (default $DEFAULT_REF); a rollback
                         is --ref <older tag>
  --deploy-branch <name> where ops/ comes from (default main)
  --force                install and build even when src/ was already built at this commit
  --import-env           only: add the NAME=value lines on stdin to .env (names already there
                         are kept, nothing is printed), then exit; restart with a plain run
  -h, --help             this text

NODE_BIN (default: the newest ~/.nvm/versions/node/v24.*/bin, linked as node/) is where node
and corepack come from. REPO_URL (default the GitHub repository) is what src/ fetches; a local
path deploys commits that are not pushed yet.
A deploy that rebuilds builds in src/ while the old processes still run, then restarts them:
both sites answer from the old build until the restart (a few seconds of 502 then).

Exit codes: 0 deployed, 1 a step failed, 2 usage, 3 refused (root, another host or user,
a missing tool, no passwordless sudo, not installed yet), 4 a server did not get ready,
5 nginx on this VM does not answer as expected, 6 this VM answers but the edge does not.
EOF
}

INSTALL=0
REF="$DEFAULT_REF"
DEPLOY_BRANCH=main
FORCE=0
IMPORT_ONLY=0
while (($#)); do
  case "$1" in
    --install) INSTALL=1 ;;
    --ref)
      [[ $# -ge 2 && -n "$2" ]] || { echo "prod.sh: --ref needs a tag or a commit" >&2; exit 2; }
      REF="$2"
      shift
      ;;
    --deploy-branch)
      [[ $# -ge 2 && -n "$2" ]] || { echo "prod.sh: --deploy-branch needs a name" >&2; exit 2; }
      DEPLOY_BRANCH="$2"
      shift
      ;;
    --force) FORCE=1 ;;
    --import-env) IMPORT_ONLY=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "prod.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() { # die <exit code> <message...>
  local code="$1"
  shift
  echo "prod.sh: $*" >&2
  exit "$code"
}

sql() { sudo -n -u postgres psql -v ON_ERROR_STOP=1 -X -Atq "$@"; }

# Everything below is in functions, read whole before they run: when this script is
# $OPS/deploy/examples/prod.sh, the checkout step rewrites it under a running bash.
main() {
  [[ $EUID -ne 0 ]] || die 3 "refusing to run as root — run it as $EXPECTED_USER"
  [[ "$(hostname)" == "$EXPECTED_HOST" ]] ||
    die 3 "refusing to run on $(hostname) — this script deploys production on $EXPECTED_HOST"
  [[ "$(id -un)" == "$EXPECTED_USER" ]] || die 3 "refusing to run as $(id -un) — the sites belong to $EXPECTED_USER"

  mkdir -p "$ROOT"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || die 1 "another deploy of $ROOT is running"

  if ((IMPORT_ONLY)); then
    import_env
    return
  fi

  local tool
  for tool in git curl flock sudo sha256sum openssl systemctl; do
    command -v "$tool" >/dev/null || die 3 "$tool is required (sudo apt install $tool)"
  done
  sudo -n true 2>/dev/null || die 3 "passwordless sudo is required (psql as postgres, nginx, loginctl)"
  # NODE_ENV=production would make pnpm skip the devDependencies the build needs (tsc, vite);
  # the units get theirs from .env.
  unset NODE_ENV
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

  echo "==> node"
  pick_node
  export PATH="$NODE_LINK:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  [[ -x "$NODE_LINK/corepack" ]] || die 1 "no corepack in $(readlink "$NODE_LINK")"
  # The nvm bin dir may have a global pnpm of its own; turbo runs `pnpm run build` in every
  # package, which must be the pinned packageManager, so corepack's shim goes first.
  mkdir -p "$SHIMS"
  corepack enable --install-directory "$SHIMS" pnpm
  export PATH="$SHIMS:$PATH"
  [[ "$(command -v pnpm)" == "$SHIMS/pnpm" ]] || die 1 "pnpm on PATH is $(command -v pnpm), not $SHIMS/pnpm"
  echo "    $NODE_LINK -> $(readlink "$NODE_LINK") ($(node --version))"

  echo "==> source"
  if [[ ! -d "$SRC/.git" ]]; then
    timeout 300 git clone --quiet "$REPO_URL" "$SRC"
  fi
  git -C "$SRC" remote set-url origin "$REPO_URL"
  # --force: a tag moved upstream is taken as it is now
  timeout 120 git -C "$SRC" fetch --quiet --prune --tags --force origin

  # ops/: the deployment files at origin/<deploy branch>. The units and the vhosts link here:
  # a commit without them would leave nginx a dangling include (the next reload of any site
  # on the VM fails) and systemd a dangling unit.
  git -C "$SRC" rev-parse --verify --quiet "origin/$DEPLOY_BRANCH" >/dev/null ||
    die 1 "origin has no branch $DEPLOY_BRANCH"
  local f
  for f in "${UNIT_FILES[@]/#/$UNIT_REL/}" "$BACKUP_REL" "$VHOST_REL/$EXAMPLES_HOST.conf" "$VHOST_REL/$SERVICE_HOST.conf"; do
    git -C "$SRC" cat-file -e "origin/$DEPLOY_BRANCH:$f" 2>/dev/null ||
      die 1 "origin/$DEPLOY_BRANCH has no $f, refusing to check it out"
  done
  local vhosts_before="" vhosts_after="" units_before="" units_after=""
  if [[ -d "$OPS/$VHOST_REL" ]]; then
    vhosts_before="$(cat "$OPS/$VHOST_REL"/*.conf | sha256sum)"
    units_before="$(cat "$OPS/$UNIT_REL"/* | sha256sum)"
  fi
  if [[ ! -e "$OPS/.git" ]]; then
    git -C "$SRC" worktree prune
    git -C "$SRC" worktree add --quiet --detach "$OPS" "origin/$DEPLOY_BRANCH"
  fi
  git -C "$OPS" checkout --quiet --force --detach "origin/$DEPLOY_BRANCH"
  git -C "$OPS" clean --quiet -ffd
  vhosts_after="$(cat "$OPS/$VHOST_REL"/*.conf | sha256sum)"
  units_after="$(cat "$OPS/$UNIT_REL"/* | sha256sum)"
  echo "    ops/ at $DEPLOY_BRANCH $(git -C "$OPS" rev-parse --short=7 HEAD): $(git -C "$OPS" log -1 --format=%s)"

  # src/: the application at --ref (a tag first, then a remote branch, then a commit).
  local target
  target="$(git -C "$SRC" rev-parse --verify --quiet "refs/tags/$REF^{commit}" ||
    git -C "$SRC" rev-parse --verify --quiet "refs/remotes/origin/$REF^{commit}" ||
    git -C "$SRC" rev-parse --verify --quiet "$REF^{commit}" || true)"
  [[ -n "$target" ]] || die 1 "no tag, branch or commit $REF on origin"
  # the service site (apps/service) and this layout need a release from 1.1.0 on
  for f in apps/service/package.json apps/examples/package.json packages/server/package.json \
    menu.yaml menu-service.yaml lookups.yaml; do
    git -C "$SRC" cat-file -e "$target:$f" 2>/dev/null ||
      die 1 "$REF has no $f: not a release this deployment can run (1.1.0 or later)"
  done
  local built=""
  [[ -f "$BUILT" ]] && built="$(cat "$BUILT")"
  git -C "$SRC" checkout --quiet --force --detach "$target"
  # -x also removes ignored files; node_modules and the dist/ the running units load stay
  # (a build overwrites dist/ in place).
  git -C "$SRC" clean --quiet -ffdx -e node_modules -e dist
  local sha
  sha="$(git -C "$SRC" rev-parse --short=7 HEAD)"
  echo "    src/ at $REF ($sha): $(git -C "$SRC" log -1 --format=%s)"

  if ((!FORCE)) && [[ "$built" == "$target" && -f "$SRC/packages/server/dist/server.js" ]]; then
    echo "==> build: src/ is already built at $sha, not rebuilding"
  else
    rm -f "$BUILT"
    echo "==> pnpm install"
    (cd "$SRC" && timeout 900 corepack pnpm install --frozen-lockfile)
    echo "==> build (${FILTERS[*]})"
    (cd "$SRC" && timeout 900 corepack pnpm turbo run build "${FILTERS[@]}")
    for f in packages/server/dist/server.js packages/cli/dist/main.js \
      apps/examples/dist/index.html apps/service/dist/index.html; do
      [[ -f "$SRC/$f" ]] || die 1 "the build left no $f"
    done
    printf '%s\n' "$target" >"$BUILT"
  fi
  write_cli
  echo "    $("$MEMENTO_BIN" --version 2>/dev/null | sed 's/^/memento --version: /')"

  if ((INSTALL)); then
    echo "==> install: PostgreSQL role and database $DB_NAME"
    install_db
    echo "==> install: .env"
    install_env
    echo "==> install: tenant $DEMO_TENANT and its keys"
    install_keys
    echo "==> install: linger (the units start at boot)"
    sudo -n loginctl enable-linger "$EXPECTED_USER"
    echo "==> install: units"
    install_units
  fi
  [[ -f "$ENV_FILE" ]] || die 3 "no $ENV_FILE — run deploy/examples/prod.sh --install"
  check_env
  mkdir -p "$CANDIDATES"

  echo "==> units"
  for f in "${UNIT_FILES[@]}"; do
    [[ "$(readlink "$UNIT_DIR/$f" 2>/dev/null)" == "$OPS/$UNIT_REL/$f" ]] ||
      die 3 "$UNIT_DIR/$f is not linked to ops/; run deploy/examples/prod.sh --install"
  done
  # the unit files may have changed with ops/
  timeout 30 systemctl --user daemon-reload
  [[ "$units_before" != "$units_after" && -n "$units_before" ]] && echo "    the unit files changed"
  # one transaction: After= starts memento-prod first, the rest once it runs
  timeout 120 systemctl --user restart "${RUNNING[@]}"
  timeout 30 systemctl --user start "${TIMERS[@]}"
  echo "    restarted ${RUNNING[*]}"
  wait_ready "${SERVERS[0]}" "$EXAMPLES_PORT"
  wait_ready "${SERVERS[1]}" "$SERVICE_PORT"
  wait_active

  echo "==> nginx vhosts"
  if ((INSTALL)); then
    install_vhosts
  else
    local host
    for host in "${VHOSTS[@]}"; do
      [[ "$(readlink "/etc/nginx/sites-available/$host" 2>/dev/null)" == "$OPS/$VHOST_REL/$host.conf" &&
        "$(readlink "/etc/nginx/sites-enabled/$host" 2>/dev/null)" == "/etc/nginx/sites-available/$host" ]] ||
        die 3 "/etc/nginx/sites-enabled/$host is not linked to ops/; run deploy/examples/prod.sh --install"
    done
    if [[ "$vhosts_before" != "$vhosts_after" ]]; then
      sudo -n nginx -t
      sudo -n systemctl reload nginx
      echo "    a vhost changed, nginx reloaded"
    else
      echo "    unchanged"
    fi
  fi

  check
  echo "prod.sh: https://$EXAMPLES_HOST and https://$SERVICE_HOST serve $REF ($sha)"
}

newest_node24() {
  find "$HOME/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v24.*' 2>/dev/null |
    sort -V | tail -n 1 | sed 's:$:/bin:'
}

# node/ -> NODE_BIN when it is set, else the newest installed Node 24 (nvm install 24 if none).
pick_node() {
  local bin="${NODE_BIN:-}"
  if [[ -z "$bin" ]]; then
    bin="$(newest_node24)"
    if [[ -z "$bin" || ! -x "$bin/node" ]]; then
      [[ -s "$HOME/.nvm/nvm.sh" ]] || die 1 "no Node 24 under ~/.nvm and no nvm to install one"
      echo "    no Node 24 under ~/.nvm — nvm install 24"
      # shellcheck source=/dev/null
      (. "$HOME/.nvm/nvm.sh" && timeout 600 nvm install 24 >/dev/null)
      bin="$(newest_node24)"
    fi
  fi
  [[ -n "$bin" && -x "$bin/node" ]] || die 1 "no node at ${bin:-<none>}"
  if [[ "$(readlink "$NODE_LINK" 2>/dev/null)" != "$bin" ]]; then
    ln -sfn "$bin" "$ROOT/.node.tmp"
    mv -T "$ROOT/.node.tmp" "$NODE_LINK"
  fi
}

# bin/memento: the CLI of src/ with this deployment's .env. .env is read line by line, not
# sourced: a value like `memento <info@…>` is not valid shell.
write_cli() {
  mkdir -p "$(dirname "$MEMENTO_BIN")"
  cat >"$MEMENTO_BIN.tmp" <<EOF
#!/usr/bin/env bash
# written by deploy/examples/prod.sh: the memento CLI of $SRC with $ENV_FILE
set -euo pipefail
if [[ -r "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "\$line" ]]; do
    [[ "\$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "\$line"
  done <"$ENV_FILE"
fi
# the pushers' keys are theirs; an operator's command names its own key when it needs one
unset CPU_MONITOR_API_KEY SIMULATOR_API_KEY MEMENTO_DEMO_API_KEY
exec "$NODE_LINK/node" "$SRC/packages/cli/dist/main.js" "\$@"
EOF
  chmod 755 "$MEMENTO_BIN.tmp"
  mv -f "$MEMENTO_BIN.tmp" "$MEMENTO_BIN"
}

# Role $DB_USER and database $DB_NAME on the local PostgreSQL, the password only in .env.
# An existing DATABASE_URL is kept; a missing one gets a fresh password set on the role.
install_db() {
  local have_role have_db pw
  have_role="$(sql -c "select 1 from pg_roles where rolname = '$DB_USER'")"
  have_db="$(sql -c "select 1 from pg_database where datname = '$DB_NAME'")"
  if [[ "$have_role" == 1 ]] && env_has DATABASE_URL; then
    echo "    role $DB_USER exists and .env has DATABASE_URL — kept"
  else
    pw="$(openssl rand -hex 24)"
    # the password goes to psql on stdin, not on a command line other users could read
    if [[ "$have_role" == 1 ]]; then
      echo "    role $DB_USER exists but .env has no DATABASE_URL — new password"
      printf "alter role %s with login password '%s';\n" "$DB_USER" "$pw" | sql
    else
      echo "    create role $DB_USER"
      printf "create role %s with login password '%s';\n" "$DB_USER" "$pw" | sql
    fi
    env_set DATABASE_URL "postgresql://$DB_USER:$pw@127.0.0.1:5432/$DB_NAME" force
    echo "    DATABASE_URL written to .env"
  fi
  if [[ "$have_db" == 1 ]]; then
    echo "    database $DB_NAME exists"
  else
    echo "    create database $DB_NAME owner $DB_USER"
    sql -c "create database $DB_NAME owner $DB_USER"
  fi
}

# .env: every shared variable, added when missing, an existing value never changed.
# (Names: packages/server/src/config.ts; MEMENTO_URL and the pushers' for the CLI.)
# The Brevo key and MEMENTO_MAIL_FROM come with --import-env; without them mails are logged.
install_env() {
  local kv added=0
  for kv in \
    "NODE_ENV=production" \
    "HOST=127.0.0.1" \
    "LOG_LEVEL=info" \
    "REDIS_URL=$REDIS_URL_DEFAULT" \
    "REDIS_CHANNEL_PREFIX=$REDIS_CHANNEL_PREFIX_DEFAULT" \
    "MEMENTO_DEFAULT_LOCALE=en" \
    "MEMENTO_LOOKUPS_STRICT=false" \
    "MEMENTO_CANDIDATES_DIR=$CANDIDATES" \
    "MEMENTO_SERVICE_URL=https://$SERVICE_HOST" \
    "MEMENTO_DEFAULT_MAX_KEYS=10" \
    "MEMENTO_DEFAULT_DAILY_LIMIT=100000" \
    "MEMENTO_URL=http://127.0.0.1:$EXAMPLES_PORT/memento" \
    "CPU_MONITOR_TENANT=$DEMO_TENANT" \
    "CPU_MONITOR_INTERVAL=5" \
    "CPU_MONITOR_INSTANCE_ID=production" \
    "SIMULATOR_TENANT=$DEMO_TENANT" \
    "SIMULATOR_INTERVAL=10"; do
    if ! env_has "${kv%%=*}"; then
      env_set "${kv%%=*}" "${kv#*=}"
      added=$((added + 1))
    fi
  done
  chmod 600 "$ENV_FILE"
  echo "    $added variable(s) added, the rest kept (mode 600)"
  local name
  for name in MEMENTO_BREVO_API_KEY MEMENTO_MAIL_FROM; do
    env_has "$name" || echo "    no $name yet: mails are logged, not sent (add it with --import-env)"
  done
}

# The tenant `demo` (the examples site and the pushers), its read-only key for
# GET /memento/api/demo, one write key per pusher. Keys are created only for a missing variable
# (a key is shown once: one that is lost is revoked by hand and its variable removed).
install_keys() {
  "$MEMENTO_BIN" migrate >/dev/null
  if "$MEMENTO_BIN" --json list-tenants | node -e '
      const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
      process.exit((t.data ?? t).some((x) => x.slug === process.argv[1]) ? 0 : 1)' "$DEMO_TENANT"; then
    echo "    tenant $DEMO_TENANT exists"
  else
    "$MEMENTO_BIN" create-tenant "$DEMO_TENANT" --name "Demo Tenant" >/dev/null
    echo "    created tenant $DEMO_TENANT"
  fi
  local spec var scopes name key
  for spec in "MEMENTO_DEMO_API_KEY read examples-demo" \
    "CPU_MONITOR_API_KEY write cpu-monitor-push" \
    "SIMULATOR_API_KEY write simulator-push"; do
    read -r var scopes name <<<"$spec"
    if env_has "$var"; then
      echo "    $var exists — kept"
      continue
    fi
    key="$("$MEMENTO_BIN" --json create-key --tenant "$DEMO_TENANT" --scopes "$scopes" --name "$name" |
      node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write((j.data ?? j).key)')"
    [[ "$key" == mk_* ]] || die 1 "memento create-key did not print a key for $name"
    env_set "$var" "$key"
    echo "    $var written (key \"$name\", $scopes)"
  done
}

# --import-env: NAME=value lines on stdin into .env; a name already there is kept. Nothing is
# echoed but the names.
import_env() {
  [[ ! -t 0 ]] || die 2 "--import-env reads NAME=value lines from stdin"
  local line name n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || die 2 "--import-env: a line is not NAME=value"
    name="${line%%=*}"
    if env_has "$name"; then
      echo "    $name exists — kept"
    else
      env_set "$name" "${line#*=}"
      echo "    $name added"
      n=$((n + 1))
    fi
  done
  echo "prod.sh: $n variable(s) added to $ENV_FILE; restart with deploy/examples/prod.sh"
}

env_has() { [[ -f "$ENV_FILE" ]] && grep -q "^$1=." "$ENV_FILE"; }

# env_set NAME VALUE [force]: append NAME=VALUE (force: drop an existing NAME line first).
# Created with umask 077; systemd's EnvironmentFile and bin/memento both read it. Values are
# written unquoted (systemd would strip quotes, bin/memento would not).
env_set() {
  (
    umask 077
    if [[ ! -f "$ENV_FILE" ]]; then
      printf '# %s and %s: the production memento sites (docs/DEPLOYMENT.md "Production"),\n# written by deploy/examples/prod.sh on %s; read by the units %s and bin/memento.\n# Not shell syntax: do not source it.\n' \
        "$EXAMPLES_HOST" "$SERVICE_HOST" "$(date -Is)" "${UNIT_FILES[*]}" >"$ENV_FILE"
    fi
    if [[ "${3:-}" == force ]]; then
      grep -v "^$1=" "$ENV_FILE" >"$ENV_FILE.tmp" || true
      mv -f "$ENV_FILE.tmp" "$ENV_FILE"
    fi
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

# .env must not set what the units set per process (EnvironmentFile= would win).
check_env() {
  local name
  for name in "${PER_UNIT[@]}"; do
    if grep -q "^$name=" "$ENV_FILE"; then
      die 3 "$ENV_FILE sets $name, which the units set per process; remove that line"
    fi
  done
  [[ "$(stat -c %a "$ENV_FILE")" == 600 ]] || chmod 600 "$ENV_FILE"
}

# ~/.config/systemd/user/<unit> -> ops/deploy/examples/systemd/<unit>, enabled (the servers and
# pushers are started by the caller, the timer here).
install_units() {
  mkdir -p "$UNIT_DIR"
  local f dst
  for f in "${UNIT_FILES[@]}"; do
    dst="$UNIT_DIR/$f"
    if [[ -f "$dst" && ! -L "$dst" ]]; then
      echo "    $dst is a regular file, keeping it as $dst.bak"
      mv -f "$dst" "$dst.bak"
    fi
    ln -sfn "$OPS/$UNIT_REL/$f" "$dst"
  done
  timeout 30 systemctl --user daemon-reload
  timeout 30 systemctl --user enable --quiet "${RUNNING[@]}" "${TIMERS[@]}"
  echo "    ${UNIT_FILES[*]} linked from ops/$UNIT_REL (enabled)"
}

# sites-available/<host> -> ops/deploy/examples/nginx/<host>.conf, sites-enabled ->
# sites-available, as every site on this VM. A hand-written "coming soon" vhost that was there
# stays beside it as <host>.coming-soon (nginx includes only sites-enabled/*); its page in
# /var/www/<host> is not touched.
install_vhosts() {
  local host avail enabled src
  for host in "${VHOSTS[@]}"; do
    src="$OPS/$VHOST_REL/$host.conf"
    avail="/etc/nginx/sites-available/$host"
    enabled="/etc/nginx/sites-enabled/$host"
    [[ -f "$src" ]] || die 1 "no $src in ops/"
    if [[ -f "$avail" && ! -L "$avail" ]]; then
      if [[ -e "$avail.coming-soon" ]]; then
        die 1 "$avail is a regular file and $avail.coming-soon exists already; move one of them by hand"
      fi
      echo "    keeping the previous regular file as $avail.coming-soon"
      sudo -n mv "$avail" "$avail.coming-soon"
    fi
    sudo -n ln -sfn "$src" "$avail"
    sudo -n ln -sfn "$avail" "$enabled"
    echo "    $enabled -> $avail -> $src"
  done
  sudo -n nginx -t
  sudo -n systemctl reload nginx
  echo "    nginx reloaded"
}

wait_ready() { # wait_ready <unit> <port>
  local url="http://127.0.0.1:$2/memento/api/health"
  echo "==> $url"
  local code="" deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
    [[ "$code" == 200 ]] && break
    sleep 2
  done
  [[ "$code" == 200 ]] || die 4 "$1 is not ready (last answer: ${code:-none}): journalctl --user -u $1 -n 50"
  echo "    200"
}

# Every unit active; a pusher may be between two attempts when it raced the server.
wait_active() {
  local unit deadline=$((SECONDS + 30))
  for unit in "${RUNNING[@]}"; do
    until systemctl --user is-active --quiet "$unit" || ((SECONDS >= deadline)); do sleep 1; done
    systemctl --user is-active --quiet "$unit" ||
      die 4 "$unit is not active: journalctl --user -u $unit -n 50"
  done
  for unit in "${TIMERS[@]}"; do
    systemctl --user is-active --quiet "$unit" || die 4 "$unit is not active"
  done
  echo "    ${RUNNING[*]} ${TIMERS[*]}: active"
  backup_status
}

# The newest dump in backups/ and its age; a warning, not a failure, when there is none (the
# first day after --install) or it is older than two days (the timer's run failed).
backup_status() {
  local newest age
  newest="$(find "$BACKUPS" -maxdepth 1 -name 'memento-*.dump' -printf '%T@ %p\n' 2>/dev/null |
    sort -n | tail -n 1 | cut -d' ' -f2-)"
  if [[ -z "$newest" ]]; then
    echo "    no backup in $BACKUPS yet (memento-prod-backup.timer: daily at 02:30 UTC;" \
      "now: systemctl --user start memento-prod-backup)"
    return
  fi
  age=$(($(date +%s) - $(stat -c %Y "$newest")))
  echo "    newest backup: ${newest##*/}, $((age / 3600)) h old"
  if ((age > 2 * 86400)); then
    echo "prod.sh: WARNING — no backup for $((age / 86400)) days: journalctl --user -u memento-prod-backup" >&2
  fi
}

local_get() { # local_get <host> <path>: the body, then the status on the last line
  curl -s -w '\n%{http_code}' --max-time 15 -H "Host: $1" "http://127.0.0.1$2" || true
}

expect_local() { # expect_local <host> <path> <status> <substring of the body>
  local body code deadline=$((SECONDS + 30))
  echo "==> http://127.0.0.1$2 (Host: $1)"
  # Right after a reload nginx's old workers may still answer from the "coming soon" vhost,
  # which gave every path a 200 with its own page; wait for the server's answer.
  until body="$(local_get "$1" "$2")" && [[ "${body##*$'\n'}" == "$3" && "$body" == *"$4"* ]] ||
    ((SECONDS >= deadline)); do
    sleep 1
  done
  code="${body##*$'\n'}"
  if [[ "$code" != "$3" || "$body" != *"$4"* ]]; then
    echo "prod.sh: FAILED — nginx on this VM answers $code for $1$2, not $3 with \"$4\"" >&2
    echo "  curl -si -H 'Host: $1' http://127.0.0.1$2 ; tail /var/log/nginx/$1.error.log" >&2
    exit 5
  fi
  echo "    $code, \"$4\""
}

check() {
  local version
  version="$("$MEMENTO_BIN" --version)"
  echo "==> memento --version: $version"
  expect_local "$EXAMPLES_HOST" /memento/api/health 200 '"status":"ok"'
  expect_local "$EXAMPLES_HOST" / 200 '<title>memento examples</title>'
  expect_local "$EXAMPLES_HOST" /memento/api/demo 200 "\"tenant\":\"$DEMO_TENANT\""
  expect_local "$SERVICE_HOST" /memento/api/health 200 '"status":"ok"'
  expect_local "$SERVICE_HOST" / 200 '<title>memento service</title>'
  expect_local "$SERVICE_HOST" /memento/api/demo 404 '"not_found"'
  local host code failed=0
  for host in "${VHOSTS[@]}"; do
    echo "==> https://$host/memento/api/health"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://$host/memento/api/health" 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then
      echo "    200"
    else
      echo "    ${code:-no answer} (curl -sv https://$host/memento/api/health)" >&2
      failed=1
    fi
  done
  if ((failed)); then
    echo "prod.sh: this VM serves both sites, but the edge does not route them here yet" >&2
    exit 6
  fi
}

main
exit
