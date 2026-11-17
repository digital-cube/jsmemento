#!/usr/bin/env bash
# Deploy https://memento-service.org (the memento website, apps/website) on
# digitalcube-production-websites, build-and-swap, the same steps as deploy/website/stage.sh on
# the stage VM; https://www.memento-service.org answers a 301 to it (the vhost).
#
# Two checkouts of digital-cube/jsmemento under $ROOT, one clone (src/ is the repository,
# ops/ a `git worktree` of it), as deploy/examples/prod.sh has them:
#   src/  the SITE, detached at a release: by default the newest v<x.y.z> tag on origin
#         (v1.1.0 today), --ref <tag|branch|sha> for another (a rollback is --ref <older tag>).
#         Production serves releases, not main: the footer names the tag and its date.
#   ops/  the DEPLOYMENT files, detached at origin/main (--deploy-branch): this script and the
#         vhost. They are newer than the tag they deploy (v1.1.0 has no deploy/website/prod.sh),
#         so they cannot come from the site's checkout; sites-available links into ops/.
# Each run: fetch (with the tags) -> check out both -> pnpm (src/'s packageManager, through
# corepack) install of @jsmemento/website and its dependencies only -> build with
#   SITE_URL=https://memento-service.org
#   EXAMPLE_URL=https://examples.memento-service.org
#   SERVICE_URL=https://service.memento-service.org
# -> apps/website/dist to releases/<short sha> -> atomically repoint `current` -> keep the last
# three releases -> through nginx on 127.0.0.1 (/, www 301, the site's 404, a deep page) and
# through the edge (200 with this build's canonical link, www 301).
# Idempotent: when releases/<short sha> already holds that commit built with the same tag and
# variables and `current` points at it, nothing is installed, built or moved; the script only
# checks the site again.
# The footer and the Packages table are read at build time (apps/website/src/build-info.mjs):
# the commit and the release from git (hence the full clone with tags), the packages from
# registry.npmjs.org (without a way out to it the build still succeeds and says "unknown").
#
# Works from any copy of the script (scp it to /tmp for the first run): it deploys what GitHub
# has, not the checkout it was started from. After the first run it lives in
# $ROOT/ops/deploy/website/prod.sh.
#
# Usage: deploy/website/prod.sh [--install] [--ref <tag|branch|sha>] [--deploy-branch <name>] [--force]
set -euo pipefail

ROOT=/home/digital/sites/memento-service.org
SRC="$ROOT/src"        # the site, at --ref
OPS="$ROOT/ops"        # the deployment files, at origin/<deploy branch>
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
NODE_LINK="$ROOT/node" # -> the nvm bin dir the build runs with
SHIMS="$ROOT/corepack" # corepack's pnpm shim: the version package.json pins
REPO_URL="${REPO_URL:-https://github.com/digital-cube/jsmemento.git}"
HOST=memento-service.org
WWW_HOST="www.$HOST"
SITE_URL="https://$HOST"
EXAMPLE_URL="${EXAMPLE_URL:-https://examples.memento-service.org}"
SERVICE_URL="${SERVICE_URL:-https://service.memento-service.org}"
EXPECTED_HOST=digitalcube-production-websites
EXPECTED_USER=digital
APP=apps/website
VHOST_REL="deploy/website/nginx/$HOST.conf"
VHOST_SRC="$OPS/$VHOST_REL"
VHOST_AVAILABLE="/etc/nginx/sites-available/$HOST"
VHOST_ENABLED="/etc/nginx/sites-enabled/$HOST"
RELEASE_TAGS='v[0-9]*.[0-9]*.[0-9]*'
KEEP=3

usage() {
  cat <<EOF
Usage: deploy/website/prod.sh [--install] [--ref <tag|branch|sha>] [--deploy-branch <name>] [--force]

Runs ON $EXPECTED_HOST as $EXPECTED_USER. Builds $SITE_URL ($APP of $REPO_URL)
into $ROOT:
  src/                   the site at --ref (default: the newest release tag on origin)
  ops/                   origin/<deploy branch> (default main): this script and the vhost
  releases/<short sha>/  one built $APP/dist per commit, the last $KEEP kept
  current -> releases/…  what nginx serves, swapped atomically
  node -> ~/.nvm/…/bin   the Node the build runs with (newest installed v24)
  corepack/              corepack's pnpm shim, first on PATH (the pnpm package.json pins)
then checks through nginx on 127.0.0.1: / (200, the site's title), $WWW_HOST (301 to
$SITE_URL), a missing page (the site's 404), /get-started/sqlite/ (200); and through the edge:
$SITE_URL/ (200 with this build's canonical link), https://$WWW_HOST/get-started/ (301).

  --install              link the vhost: a hand-written regular $VHOST_AVAILABLE is kept
                         as $VHOST_AVAILABLE.coming-soon, $VHOST_AVAILABLE ->
                         ops/$VHOST_REL, $VHOST_ENABLED -> $VHOST_AVAILABLE, nginx -t,
                         reload; then deploy (once per VM; harmless to repeat)
  --ref <tag|branch|sha> what to build (default: the newest $RELEASE_TAGS tag without a
                         pre-release suffix); a rollback is --ref <older tag>
  --deploy-branch <name> where ops/ comes from (default main)
  --force                rebuild even when the release for this commit is already current
  -h, --help             this text

Build variables (src/site.mjs): SITE_URL is $SITE_URL; EXAMPLE_URL (default
https://examples.memento-service.org) and SERVICE_URL (default
https://service.memento-service.org) may be overridden from the environment.
NODE_BIN (default: the newest ~/.nvm/versions/node/v24.*/bin, linked as node/) is where node
and corepack come from.
REPO_URL (default the GitHub repository) is what src/ fetches; a local path deploys commits
that are not pushed yet. The next run without it fetches from GitHub again.

Exit codes: 0 deployed, 1 a step failed, 2 usage, 3 refused (root, another host or user,
a missing tool, no passwordless sudo), 5 nginx on this VM does not answer as expected,
6 this VM answers as expected but https://$HOST or https://$WWW_HOST does not (the edge).
EOF
}

INSTALL=0
REF=""
DEPLOY_BRANCH=main
FORCE=0
while (($#)); do
  case "$1" in
    --install) INSTALL=1 ;;
    --ref)
      [[ $# -ge 2 && -n "$2" ]] || { echo "prod.sh: --ref needs a tag, a branch or a commit" >&2; exit 2; }
      REF="$2"
      shift
      ;;
    --deploy-branch)
      [[ $# -ge 2 && -n "$2" ]] || { echo "prod.sh: --deploy-branch needs a name" >&2; exit 2; }
      DEPLOY_BRANCH="$2"
      shift
      ;;
    --force) FORCE=1 ;;
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

# Everything below is in functions, read whole before they run: when this script is
# $OPS/deploy/website/prod.sh, the checkout step rewrites it under a running bash.
main() {
  [[ $EUID -ne 0 ]] || die 3 "refusing to run as root — run it as $EXPECTED_USER"
  [[ "$(hostname)" == "$EXPECTED_HOST" ]] ||
    die 3 "refusing to run on $(hostname) — this script deploys production on $EXPECTED_HOST"
  [[ "$(id -un)" == "$EXPECTED_USER" ]] || die 3 "refusing to run as $(id -un) — the site belongs to $EXPECTED_USER"
  local tool
  for tool in git curl flock sudo sha256sum; do
    command -v "$tool" >/dev/null || die 3 "$tool is required (sudo apt install $tool)"
  done
  sudo -n true 2>/dev/null || die 3 "passwordless sudo is required (nginx)"
  # NODE_ENV=production would make pnpm skip the devDependencies the build needs (astro).
  unset NODE_ENV

  mkdir -p "$RELEASES"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || die 1 "another deploy of $HOST is running"

  echo "==> node"
  pick_node
  export PATH="$NODE_LINK:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  [[ -x "$NODE_LINK/corepack" ]] || die 1 "no corepack in $(readlink "$NODE_LINK")"
  # The nvm bin dir on this VM has a global pnpm of its own; the website's build runs
  # `pnpm run …` inside, which must be the pinned packageManager too, so corepack's pnpm shim
  # goes first on PATH.
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
  # --tags: the default ref and the footer's release are the tags; --prune-tags --force: a tag
  # deleted or moved on origin is deleted or moved here too.
  timeout 120 git -C "$SRC" fetch --quiet --prune --prune-tags --tags --force origin

  # ops/: the deployment files at origin/<deploy branch>. sites-available links here: a commit
  # without the vhost would leave nginx a dangling include, and the next reload of any site on
  # the VM would fail.
  git -C "$SRC" rev-parse --verify --quiet "origin/$DEPLOY_BRANCH" >/dev/null ||
    die 1 "origin has no branch $DEPLOY_BRANCH"
  git -C "$SRC" cat-file -e "origin/$DEPLOY_BRANCH:$VHOST_REL" 2>/dev/null ||
    die 1 "origin/$DEPLOY_BRANCH has no $VHOST_REL, refusing to check it out"
  local vhost_before="" vhost_after=""
  [[ -f "$VHOST_SRC" ]] && vhost_before="$(sha256sum <"$VHOST_SRC")"
  if [[ ! -e "$OPS/.git" ]]; then
    git -C "$SRC" worktree prune
    git -C "$SRC" worktree add --quiet --detach "$OPS" "origin/$DEPLOY_BRANCH"
  fi
  git -C "$OPS" checkout --quiet --force --detach "origin/$DEPLOY_BRANCH"
  git -C "$OPS" clean --quiet -ffd
  vhost_after="$(sha256sum <"$VHOST_SRC")"
  echo "    ops/ at $DEPLOY_BRANCH $(git -C "$OPS" rev-parse --short=7 HEAD): $(git -C "$OPS" log -1 --format=%s)"

  # src/: the site at --ref (a tag first, then a remote branch, then a commit); without --ref
  # the newest release tag.
  if [[ -z "$REF" ]]; then
    REF="$(git -C "$SRC" tag --list "$RELEASE_TAGS" --sort=-v:refname | grep -v -- - | head -n 1 || true)"
    [[ -n "$REF" ]] || die 1 "origin has no release tag ($RELEASE_TAGS); name one with --ref"
  fi
  local target
  target="$(git -C "$SRC" rev-parse --verify --quiet "refs/tags/$REF^{commit}" ||
    git -C "$SRC" rev-parse --verify --quiet "refs/remotes/origin/$REF^{commit}" ||
    git -C "$SRC" rev-parse --verify --quiet "$REF^{commit}" || true)"
  [[ -n "$target" ]] || die 1 "no tag, branch or commit $REF on origin"
  git -C "$SRC" cat-file -e "$target:$APP/src/site.mjs" 2>/dev/null ||
    die 1 "$REF has no $APP/src/site.mjs: not a release of the website this script can build"
  git -C "$SRC" checkout --quiet --force --detach "$target"
  git -C "$SRC" clean --quiet -ffdx -e node_modules

  local sha
  sha="$(git -C "$SRC" rev-parse --short=7 HEAD)"
  echo "    src/ at $REF ($sha): $(git -C "$SRC" log -1 --format=%s)"

  echo "==> nginx vhost"
  if ((INSTALL)); then
    install_vhost
  elif [[ "$(readlink "$VHOST_AVAILABLE" 2>/dev/null)" != "$VHOST_SRC" ||
    "$(readlink "$VHOST_ENABLED" 2>/dev/null)" != "$VHOST_AVAILABLE" ]]; then
    die 1 "$VHOST_ENABLED -> $VHOST_AVAILABLE -> $VHOST_SRC is not linked; run deploy/website/prod.sh --install"
  elif [[ "$vhost_before" != "$vhost_after" ]]; then
    sudo -n nginx -t
    sudo -n systemctl reload nginx
    echo "    the vhost changed, nginx reloaded"
  else
    echo "    unchanged"
  fi

  # What a release was built from; a release is reused only when all of it matches. The tag is
  # in it because the footer shows it and its date.
  local stamp tag release="$RELEASES/$sha"
  tag="$(git -C "$SRC" describe --tags --abbrev=0 --match "$RELEASE_TAGS" --exclude '*-*' HEAD 2>/dev/null || true)"
  stamp="$(printf 'commit=%s\ntag=%s\nsite_url=%s\nexample_url=%s\nservice_url=%s\n' \
    "$(git -C "$SRC" rev-parse HEAD)" "$tag" "$SITE_URL" "$EXAMPLE_URL" "$SERVICE_URL")"

  if ((!FORCE)) && [[ -f "$release/.release" && "$(cat "$release/.release")" == "$stamp" ]]; then
    echo "==> build: releases/$sha already has $sha for these variables, not rebuilding"
  else
    # pnpm is the version src/ pins in package.json's packageManager.
    echo "==> pnpm install (@jsmemento/website and its dependencies)"
    (cd "$SRC" && timeout 600 corepack pnpm install --frozen-lockfile --filter "@jsmemento/website...")
    echo "==> build (SITE_URL=$SITE_URL EXAMPLE_URL=$EXAMPLE_URL SERVICE_URL=$SERVICE_URL)"
    (cd "$SRC" && SITE_URL="$SITE_URL" EXAMPLE_URL="$EXAMPLE_URL" SERVICE_URL="$SERVICE_URL" \
      timeout 600 corepack pnpm --filter @jsmemento/website build)
    [[ -f "$SRC/$APP/dist/index.html" ]] || die 1 "the build left no $APP/dist/index.html"

    local next="$release.new"
    rm -rf "$next"
    cp -a "$SRC/$APP/dist" "$next"
    printf '%s\n' "$stamp" >"$next/.release"
    if [[ -e "$release" ]]; then
      # A rebuild of the same commit: serve .new while the old copy is replaced.
      swap "$sha.new"
      rm -rf "$release"
      cp -a "$next" "$release"
      swap "$sha"
      rm -rf "$next"
    else
      mv "$next" "$release"
    fi
  fi

  if [[ "$(readlink "$CURRENT" 2>/dev/null)" == "releases/$sha" ]]; then
    echo "==> current: already releases/$sha"
  else
    touch "$release"
    swap "$sha"
    echo "==> current -> releases/$sha"
  fi

  echo "==> prune (keep $KEEP)"
  local old
  # newest first by the time each release became current; never the current one
  # shellcheck disable=SC2012 # release names are short shas, ls -t sorts them by mtime
  ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP + 1)) | while read -r old; do
    [[ "$old" == "$RELEASES/$sha" ]] && continue
    echo "    removing releases/${old##*/}"
    rm -rf "$old"
  done

  check
  echo "prod.sh: $SITE_URL serves $REF ($sha)"
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

# sites-available/memento-service.org -> $VHOST_SRC, sites-enabled -> sites-available, as every
# site on this VM. A hand-written regular file that was there stays beside it as
# $VHOST_AVAILABLE.coming-soon (nginx includes only sites-enabled/*).
install_vhost() {
  [[ -f "$VHOST_SRC" ]] || die 1 "no $VHOST_SRC in ops/"
  if [[ -f "$VHOST_AVAILABLE" && ! -L "$VHOST_AVAILABLE" ]]; then
    if [[ -e "$VHOST_AVAILABLE.coming-soon" ]]; then
      die 1 "$VHOST_AVAILABLE is a regular file and $VHOST_AVAILABLE.coming-soon exists already; move one of them by hand"
    fi
    echo "    keeping the previous regular file as $VHOST_AVAILABLE.coming-soon"
    sudo -n mv "$VHOST_AVAILABLE" "$VHOST_AVAILABLE.coming-soon"
  fi
  sudo -n ln -sfn "$VHOST_SRC" "$VHOST_AVAILABLE"
  sudo -n ln -sfn "$VHOST_AVAILABLE" "$VHOST_ENABLED"
  sudo -n nginx -t
  sudo -n systemctl reload nginx
  echo "    $VHOST_ENABLED -> $VHOST_AVAILABLE -> $VHOST_SRC, nginx reloaded"
}

# Point `current` at releases/<name> with one rename(2): no moment without it.
swap() {
  ln -sfn "releases/$1" "$ROOT/.current.tmp"
  mv -T "$ROOT/.current.tmp" "$CURRENT"
}

# local <host> <path> [curl args…]: nginx on this VM, with that Host header.
local_curl() {
  local host="$1" path="$2"
  shift 2
  curl -s --max-time 15 -H "Host: $host" "$@" "http://127.0.0.1$path" || true
}

local_code() { local_curl "$1" "$2" -o /dev/null -w '%{http_code}'; }

check() {
  local code body location
  echo "==> http://127.0.0.1 (Host: $HOST, $WWW_HOST)"
  # The body is checked, not only the status: for a moment after a reload nginx's old workers
  # may still answer with the default server ("Welcome to nginx!", 200 for /, 404 for the rest).
  local deadline=$((SECONDS + 30))
  until [[ "$(local_curl "$HOST" /no-such-page/)" == *'Nothing was recorded at this address'* ]] ||
    ((SECONDS >= deadline)); do sleep 1; done

  body="$(local_curl "$HOST" / -w '\n%{http_code}')"
  code="${body##*$'\n'}"
  if [[ "$code" != 200 || "$body" != *"<link rel=\"canonical\" href=\"$SITE_URL/\""* ]]; then
    echo "prod.sh: FAILED — nginx on this VM answers $code for $HOST/ without this build" >&2
    echo "  curl -sI -H 'Host: $HOST' http://127.0.0.1/ ; tail /var/log/nginx/$HOST.error.log" >&2
    exit 5
  fi
  echo "    /: 200, $(grep -o '<title>[^<]*' <<<"$body" | head -n 1 | sed 's/<title>//')"

  location="$(local_curl "$WWW_HOST" /get-started/ -o /dev/null -w '%{http_code} %{redirect_url}')"
  if [[ "$location" != "301 $SITE_URL/get-started/" ]]; then
    echo "prod.sh: FAILED — $WWW_HOST/get-started/ answers '$location', not '301 $SITE_URL/get-started/'" >&2
    exit 5
  fi
  echo "    $WWW_HOST/get-started/: 301 -> $SITE_URL/get-started/"

  body="$(local_curl "$HOST" /no-such-page/ -w '\n%{http_code}')"
  code="${body##*$'\n'}"
  if [[ "$code" != 404 || "$body" != *'Nothing was recorded at this address'* ]]; then
    echo "prod.sh: FAILED — a missing page answers $code, not the site's 404" >&2
    exit 5
  fi
  echo "    a missing page: 404 (the site's)"

  code="$(local_code "$HOST" /get-started/sqlite/)"
  [[ "$code" == 200 ]] || { echo "prod.sh: FAILED — /get-started/sqlite/ answers $code, not 200" >&2; exit 5; }
  echo "    /get-started/sqlite/: 200"

  echo "==> through the edge"
  body="$(curl -s -w '\n%{http_code}' --max-time 30 "$SITE_URL/" || true)"
  code="${body##*$'\n'}"
  if [[ "$code" != 200 || "$body" != *"<link rel=\"canonical\" href=\"$SITE_URL/\""* ]]; then
    echo "prod.sh: FAILED — this VM serves the site, but $SITE_URL/ answers $code without this build" \
      "($(grep -o '<title>[^<]*' <<<"$body" | head -n 1 | sed 's/<title>//')):" >&2
    echo "  the edge in front of this VM does not route $HOST here" >&2
    exit 6
  fi
  echo "    $SITE_URL/: 200, this build"
  location="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 30 "https://$WWW_HOST/get-started/" || true)"
  if [[ "$location" != "301 $SITE_URL/get-started/" ]]; then
    echo "prod.sh: FAILED — https://$WWW_HOST/get-started/ answers '$location', not '301 $SITE_URL/get-started/':" >&2
    echo "  the edge in front of this VM does not route $WWW_HOST here" >&2
    exit 6
  fi
  echo "    https://$WWW_HOST/get-started/: 301 -> $SITE_URL/get-started/"
}

main
exit
