#!/usr/bin/env bash
# Answers one question with an exit code: is there a recent, verified backup set? (MCL-65)
#
#   ./scripts/check-backup-freshness.sh <backup-dir> [max-age-hours]   # default 48
#
# Exit 0 only when ALL of these hold:
#
#   - <backup-dir>/last-run.status exists and its line is well-formed
#   - it records `ok` (written by backup-mc-legends.sh's EXIT trap only after the set
#     was digest-verified; a FAILED run records FAILED and this script fails on it)
#   - the recorded stamp is younger than the ceiling
#   - the set directory the stamp names still exists and still holds its database dump
#
# Any other state - including the one this script exists for, NO status at all - is
# exit 1 with a reason on stderr, and wrong usage is exit 2.
#
# Why age is checked at all: the scheduled pull runs on a laptop, and a laptop that is
# asleep, away, or has lost its LaunchAgent produces no failed run to notify about. The
# per-run notification covers "the run broke"; only age covers "the run stopped
# happening". A backup directory that merely stops getting younger looks exactly like a
# healthy one until the day it is needed.
#
# Why it is pure-local (no ssh, no network): so tests/unit/check-backup-freshness.test.ts
# can run it in CI on every `npm run test` - the same split, for the same reason, as
# verify-media-archive.sh vs backup-mc-legends.sh.
set -euo pipefail

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $(basename "$0") <backup-dir> [max-age-hours]" >&2
  exit 2
fi

DIR="$1"
MAX_AGE_HOURS="${2:-48}"
STATUS_FILE="$DIR/last-run.status"

[ -d "$DIR" ] || fail "$DIR is not a directory"
[ -f "$STATUS_FILE" ] || fail "no recorded run: $STATUS_FILE does not exist - the scheduled backup has never completed here (or its LaunchAgent is not running)"

# One line, `<stamp> ok` or `<stamp> FAILED exit=<code>` - the exact format the backup
# script's EXIT trap writes. Anything else is drift between the two scripts, and drift
# is refused rather than reinterpreted.
read -r STAMP RESULT _ < "$STATUS_FILE" || true
# An empty or truncated status file (interrupted write, full disk) must come out as the
# malformed-refusal below, not as an unbound-variable crash from `set -u`.
STAMP="${STAMP:-}"
RESULT="${RESULT:-}"

case "$STAMP" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) fail "malformed status line in $STATUS_FILE: stamp '$STAMP' is not YYYYMMDDTHHMMSSZ" ;;
esac

if [ "$RESULT" != "ok" ]; then
  fail "last run $STAMP recorded '$RESULT' in $STATUS_FILE - see $DIR/runs.log"
fi

# BSD date (macOS, where the LaunchAgent lives) first, GNU date (CI) as the fallback.
# Both parse the stamp as UTC; only the flag spelling differs.
stamp_epoch() {
  local s="$1"
  date -u -j -f '%Y%m%dT%H%M%SZ' "$s" +%s 2>/dev/null \
    || date -u -d "${s:0:4}-${s:4:2}-${s:6:2}T${s:9:2}:${s:11:2}:${s:13:2}Z" +%s
}

NOW_EPOCH="$(date -u +%s)"
STAMP_EPOCH="$(stamp_epoch "$STAMP")"
AGE_HOURS=$(( (NOW_EPOCH - STAMP_EPOCH) / 3600 ))

if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  fail "last verified set $STAMP is ${AGE_HOURS}h old, older than the ${MAX_AGE_HOURS}h ceiling - the scheduled pull has stopped producing sets"
fi

# The status can outlive its set: a hand-pruned directory, a moved backup root. A status
# that points at nothing is not a backup, so presence of the dump is part of freshness.
SET_DIR="$DIR/$STAMP"
if [ ! -f "$SET_DIR/mcl-$STAMP.dump" ]; then
  fail "status records ok for $STAMP but $SET_DIR no longer exists with its database dump"
fi

echo "ok: last verified set $STAMP (${AGE_HOURS}h old, ceiling ${MAX_AGE_HOURS}h) in $DIR"
