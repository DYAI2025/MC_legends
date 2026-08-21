#!/usr/bin/env bash
# Proves that a downloaded media archive holds the bytes the source vouched for (MCL-49).
#
#   ./scripts/verify-media-archive.sh <media-*.tar> <media-*.sha256>
#
# Exit 0 only when every recording in the archive matches the SHA-256 manifest that was
# generated ON THE VPS before the transfer, and the archive holds nothing the manifest does
# not list. Any other outcome is a non-zero exit and a message on stderr.
#
# Why this exists: scripts/backup-mc-legends.sh used to prove two things about the archive
# it had just downloaded - that `tar -tf` could list it, and that the entry count equalled
# the manifest's line count. Neither says anything about content. A transfer that corrupted
# bytes inside a recording, or truncated one while keeping its entry, passed both checks,
# and the backup then printed ok: and pruned older sets - deleting the last good copy on
# the strength of a check that could not have detected the problem.
#
# Why it is its own script rather than more lines inside the backup script: the backup
# script shells to ssh, pg_dump and pg_restore, so it can never run in CI or on a machine
# with no VPS credential. This one can, and tests/unit/verify-media-archive.test.ts runs it
# on every `npm run test`.
#
# It READS a backup and nothing else. Extraction goes to a temporary directory that is
# removed on every exit path; no production file, and no file in the backup set, is
# written, restored or renamed by this script. Quarantining a bad archive is the caller's
# decision, not this one's.
set -euo pipefail

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "usage: $(basename "$0") <media-archive.tar> <media-manifest.sha256>" >&2
  exit 2
fi

# Absolute, because the digest check runs from inside the extraction directory: the
# manifest's own paths are relative to the media root and must stay that way, while the
# path TO the manifest must not be.
TAR="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
MANIFEST="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"

[ -f "$TAR" ] || fail "no such archive: $1"
[ -r "$TAR" ] || fail "archive is not readable: $1"
[ -f "$MANIFEST" ] || fail "no such manifest: $2"
[ -r "$MANIFEST" ] || fail "manifest is not readable: $2"

# The manifest is written by sha256sum on the VPS and read here, which is usually macOS.
# Both tools read the same `<digest>␠␠<path>` format; only the name differs.
if command -v sha256sum > /dev/null 2>&1; then
  CHECKER=(sha256sum -c --quiet)
elif command -v shasum > /dev/null 2>&1; then
  CHECKER=(shasum -a 256 -c --quiet)
else
  fail "neither sha256sum nor shasum is available - cannot verify anything"
fi

# grep -c on a file with no trailing newline still counts the last line; `wc -l` would not.
MANIFEST_FILES="$(grep -c . "$MANIFEST" || true)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcl-media-verify.XXXXXX")"
# Every exit path, including the failures below and a signal: this extracts megabytes of
# recordings onto the machine that holds the only backups, and a run that leaves them
# behind fills its disk. A FAILED run is exactly when nobody is watching for that.
trap 'rm -rf "$WORK"' EXIT INT TERM

# No -P, and into a fresh directory: an archive is data, even one this project produced.
tar -xf "$TAR" -C "$WORK" || fail "could not extract $TAR"

EXTRACTED_FILES="$(find "$WORK" -type f | wc -l | tr -d ' ')"

# Both directions, and the second is not redundant. `sha256sum -c` proves every manifest
# line has a matching file; it says nothing about a file that no line vouches for. An extra
# entry means the tree changed between the two commands on the VPS - the manifest is taken
# first, the tar second - so the manifest no longer describes this archive.
if [ "$EXTRACTED_FILES" != "$MANIFEST_FILES" ]; then
  fail "archive holds $EXTRACTED_FILES file(s), manifest lists $MANIFEST_FILES"
fi

# An empty media directory is legitimate: it is the state between enabling audio storage
# and the first upload. `sha256sum -c` on an empty manifest exits non-zero with "no
# properly formatted checksum lines found", so the empty case is answered here rather than
# handed to a tool that would call it a corruption.
if [ "$MANIFEST_FILES" -eq 0 ]; then
  echo "ok: verified 0 file(s) - $TAR is empty and so is $MANIFEST"
  exit 0
fi

if ! (cd "$WORK" && "${CHECKER[@]}" "$MANIFEST" >&2); then
  fail "$TAR does not match $MANIFEST"
fi

echo "ok: verified $MANIFEST_FILES file(s) in $TAR against $MANIFEST"
