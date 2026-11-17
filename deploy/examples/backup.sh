#!/usr/bin/env bash
# Daily dump of production's PostgreSQL database `memento` (both memento-service.org sites share
# it), on digitalcube-production-websites. Run by memento-prod-backup.service, started by
# memento-prod-backup.timer; by hand: systemctl --user start memento-prod-backup
#
#   sudo -n -u postgres pg_dump -Fc memento  ->  $DIR/memento-<YYYY-MM-DD>.dump  (mode 600)
#
# The dump goes to a temporary file first; it replaces <date>.dump only when it is not empty and
# `pg_restore --list` reads it and finds the table memento_event in it. A failed run leaves the
# dumps that were there untouched and the unit in the failed state (systemctl --user --failed).
# A second run on the same (UTC) day replaces that day's dump.
#
# Then the rotation, by file name (the date in it, not mtime), only after a good dump:
#   daily   the KEEP_DAILY newest dumps (default 7)
#   weekly  the newest dump of each of the KEEP_WEEKLY newest ISO weeks (default 4) whose newest
#           dump is not already a daily one — so 7 + 4 distinct files, about five weeks back
# Counting files, not days: when backups stop for a while, the last good ones are kept.
#
# These dumps are on the same VM as the database: they cover a dropped table, a bad migration,
# an operator's mistake — not the loss of the VM. An off-VM copy is a separate decision
# (docs/DEPLOYMENT.md "Production", Backup).
#
# Restore (into an empty database memento; see docs/DEPLOYMENT.md):
#   sudo -u postgres pg_restore -d memento --no-owner --role=memento <file>
#
# Usage: deploy/examples/backup.sh [--dir <path>] [--keep-daily <n>] [--keep-weekly <n>] [--date <YYYY-MM-DD>]
# BACKUP_PG_DUMP (default "sudo -n -u postgres pg_dump") is the dump command, split on spaces;
# the database name and -Fc are appended. Tests point it at a throwaway PostgreSQL.
set -euo pipefail

DIR=/home/digital/sites/examples.memento-service.org/backups
DB_NAME=memento
KEEP_DAILY=7
KEEP_WEEKLY=4
DAY="$(date -u +%F)"
read -r -a PG_DUMP <<<"${BACKUP_PG_DUMP:-sudo -n -u postgres pg_dump}"

usage() {
  cat <<EOF
Usage: deploy/examples/backup.sh [--dir <path>] [--keep-daily <n>] [--keep-weekly <n>] [--date <YYYY-MM-DD>]

Dumps the PostgreSQL database $DB_NAME (${PG_DUMP[*]} -Fc $DB_NAME) into
<dir>/$DB_NAME-<date>.dump (mode 600), checks it (not empty, pg_restore --list reads it and
lists memento_event), then keeps the --keep-daily newest dumps and the newest dump of each of
the --keep-weekly newest older ISO weeks; the rest of <dir>/$DB_NAME-*.dump is deleted.

  --dir <path>          where the dumps are (default $DIR)
  --keep-daily <n>      default $KEEP_DAILY (at least 1)
  --keep-weekly <n>     default $KEEP_WEEKLY
  --date <YYYY-MM-DD>   the date in the file name (default today, UTC)
  -h, --help            this text

Exit codes: 0 dumped and rotated, 1 the dump or its check failed (nothing was deleted), 2 usage.
EOF
}

die() { # die <exit code> <message...>
  local code="$1"
  shift
  echo "backup.sh: $*" >&2
  exit "$code"
}

while (($#)); do
  case "$1" in
    --dir | --keep-daily | --keep-weekly | --date)
      [[ $# -ge 2 && -n "$2" ]] || die 2 "$1 needs a value"
      case "$1" in
        --dir) DIR="$2" ;;
        --keep-daily) KEEP_DAILY="$2" ;;
        --keep-weekly) KEEP_WEEKLY="$2" ;;
        --date) DAY="$2" ;;
      esac
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) echo "backup.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[[ "$KEEP_DAILY" =~ ^[0-9]+$ && "$KEEP_DAILY" -ge 1 ]] || die 2 "--keep-daily must be a number >= 1"
[[ "$KEEP_WEEKLY" =~ ^[0-9]+$ ]] || die 2 "--keep-weekly must be a number"
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && date -u -d "$DAY" >/dev/null 2>&1 ||
  die 2 "--date must be YYYY-MM-DD"

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
exec 9>"$DIR/.backup.lock"
flock -n 9 || die 1 "another backup into $DIR is running"

TARGET="$DIR/$DB_NAME-$DAY.dump"
TMP="$DIR/.$DB_NAME-$DAY.dump.partial"
trap 'rm -f "$TMP"' EXIT

dump() {
  echo "==> ${PG_DUMP[*]} -Fc $DB_NAME > $TARGET"
  local started=$SECONDS
  # stdout of pg_dump (running as postgres) is written by this shell: the file belongs to the
  # user running the unit, mode 600 through umask
  "${PG_DUMP[@]}" -Fc "$DB_NAME" >"$TMP" || die 1 "pg_dump failed; the previous dumps are untouched"
  [[ -s "$TMP" ]] || die 1 "pg_dump wrote an empty file"
  local list
  list="$(pg_restore --list "$TMP")" || die 1 "pg_restore --list cannot read the dump"
  grep -Eq 'TABLE DATA [^ ]+ memento_event ' <<<"$list" ||
    die 1 "the dump has no data of the table memento_event — not the memento database?"
  chmod 600 "$TMP"
  mv -f "$TMP" "$TARGET"
  echo "    $(du -h "$TARGET" | cut -f1), $(grep -c ' TABLE DATA ' <<<"$list") tables with data," \
    "$((SECONDS - started)) s"
}

# The dumps of $DIR by name, newest first; each line "<date> <ISO week>".
dated_dumps() {
  local f day
  for f in "$DIR/$DB_NAME"-*.dump; do
    [[ -f "$f" ]] || continue
    day="${f##*/$DB_NAME-}"
    day="${day%.dump}"
    [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    printf '%s %s\n' "$day" "$(date -u -d "$day" +%G-W%V)"
  done | sort -r
}

rotate() {
  local -A keep=() week_seen=()
  local day week n=0 weeks=0 kept=() removed=()
  # daily: the newest KEEP_DAILY; their weeks are covered
  while read -r day week; do
    [[ -n "$day" ]] || continue
    n=$((n + 1))
    if ((n <= KEEP_DAILY)); then
      keep[$day]=daily
      week_seen[$week]=1
    elif [[ -z "${week_seen[$week]:-}" ]]; then
      # the newest dump of a week no daily dump is in
      week_seen[$week]=1
      if ((weeks < KEEP_WEEKLY)); then
        keep[$day]=weekly
        weeks=$((weeks + 1))
      fi
    fi
  done < <(dated_dumps)
  while read -r day week; do
    [[ -n "$day" ]] || continue
    if [[ -n "${keep[$day]:-}" ]]; then
      kept+=("$day(${keep[$day]:0:1})")
    else
      rm -f "$DIR/$DB_NAME-$day.dump"
      removed+=("$day")
    fi
  done < <(dated_dumps)
  echo "==> rotation: keep $KEEP_DAILY daily + $KEEP_WEEKLY weekly"
  echo "    kept ${#kept[@]}: ${kept[*]}"
  ((${#removed[@]} == 0)) || echo "    removed ${#removed[@]}: ${removed[*]}"
}

dump
rotate
echo "backup.sh: $TARGET ($(df -h --output=avail "$DIR" | tail -n 1 | tr -d ' ') free on its disk)"
