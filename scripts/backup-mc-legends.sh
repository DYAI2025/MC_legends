#!/usr/bin/env bash
# Pulls one recoverable backup SET of MC Legends from the VPS to this machine (MCL-49).
#
# A set is two artefacts plus a manifest, and it needs all of them:
#
#   mcl-<stamp>.dump        pg_dump --format=custom of the `mcl` database
#   mcl-<stamp>.dump.toc    pg_restore --list of that dump, written at backup time
#   media-<stamp>.tar       the private recordings under /opt/mc-legends/data/media
#   media-<stamp>.sha256    a SHA-256 manifest generated ON THE VPS, before transfer
#
# Why both: `pg_dump` does not cover blobs on the filesystem, and a database restore whose
# object keys point at nothing is not a restore. Either stream alone recovers half a
# child's answer.
#
# Why the manifest is generated on the VPS: it is the source-side truth, captured before
# the bytes cross the network. A manifest computed here after the transfer would agree
# with a corrupted transfer, because it would be describing the corruption.
#
# What "verified" means here: the media archive is checked BY DIGEST against that manifest
# before this script prints ok or prunes anything - scripts/verify-media-archive.sh does
# it, and tests/unit/verify-media-archive.test.ts proves it does. Until 2026-08-21 the
# archive was only listed and counted, which a corrupted transfer survives.
#
# MCL_BACKUP_REQUIRE_MEDIA=1 makes an absent media directory a failed run rather than a
# warning. See the variable below, and docs/ops/MCL-48-backup-restore.md §6.1.1 for the
# exact point at which setting it stops being optional.
#
# Why this is a committed file rather than a heredoc in a runbook: MCL-48's pull script
# lived only inside a document for its first day, which is how a complete script in a
# document turns out not to be a script on a disk. This one is reviewed and diffed.
#
# It runs HERE, not on the VPS. The VPS holds no credential for this machine and opens no
# inbound port, so a compromised VPS cannot reach or delete these copies.
#
#   ./scripts/backup-mc-legends.sh [destination-directory]
#
set -euo pipefail

# launchd starts jobs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that contains no
# Homebrew. Set it explicitly, or the job works by hand and fails only when it runs
# unattended - the worst possible moment to find out. PostgreSQL >= 17 is required: the
# production server is 17.x and pg_restore refuses a dump from a newer major.
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

VPS="${MCL_BACKUP_VPS:-root@srv1308064.hstgr.cloud}"
MEDIA_DIR="${MCL_BACKUP_MEDIA_DIR:-/opt/mc-legends/data/media}"
DEST="${1:-$HOME/Backups/mc-legends}"
KEEP_DAYS="${MCL_BACKUP_KEEP_DAYS:-90}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Turns "there is no media directory on the VPS" from a warning into a failed run.
#
# Off by default, which is the pre-audio state: no client posts a recording yet, the
# directory legitimately does not exist, and a database-only set is a complete backup.
# From the moment audio persistence is live it is the opposite - a missing directory is
# data loss and a green DB-only backup is a lie - so the launchd job must set this. The
# exact moment, and how to check it, is docs/ops/MCL-48-backup-restore.md §6.1.1.
#
# Only the literal 1 turns it on, so there is one documented value and no argument about
# whether "true", "yes" or "on" counts.
REQUIRE_MEDIA="${MCL_BACKUP_REQUIRE_MEDIA:-0}"

# Resolved from this file's own location rather than the caller's working directory: the
# job that runs this unattended starts in whatever directory launchd chose.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SET="$DEST/$STAMP"
DUMP="$SET/mcl-$STAMP.dump"
MEDIA_TAR="$SET/media-$STAMP.tar"
MEDIA_MANIFEST="$SET/media-$STAMP.sha256"

mkdir -p "$SET"

# BatchMode=yes so an unattended run fails immediately instead of hanging forever on a
# passphrase or host-key prompt that nobody is sitting there to answer.
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$VPS")

fail() {
  echo "FAILED: $*" >&2
  exit 1
}

# --------------------------------------------------------------------------------------
# Stream 1: the database
# --------------------------------------------------------------------------------------
# --format=custom, not plain SQL: it is compressed, and pg_restore can list, filter and
# restore selectively from it - which is what makes the verification below possible.
# --no-owner so the dump restores into a scratch database owned by whoever runs the drill,
# without needing an mcl_app role to exist on the restoring machine.
"${SSH[@]}" "sudo -u postgres pg_dump --format=custom --no-owner --dbname=mcl" > "$DUMP"

# Verified at BACKUP time, not during an incident. A dump pg_restore cannot list is not a
# backup, it is a file - and this catches a truncated transfer, a half-written dump and a
# silently failed ssh at the moment they happen, while the source still exists.
if ! pg_restore --list "$DUMP" > "$DUMP.toc"; then
  mv "$DUMP" "$DUMP.corrupt"
  fail "pg_restore --list could not read $DUMP"
fi

# A listable but EMPTY dump is also a failure: it means pg_dump reached the wrong database
# or the table is gone.
if ! grep -q 'submission_inbox' "$DUMP.toc"; then
  mv "$DUMP" "$DUMP.corrupt"
  fail "$DUMP contains no submission_inbox"
fi

# --------------------------------------------------------------------------------------
# Stream 2: the private recordings
# --------------------------------------------------------------------------------------
# An absent media directory is a legitimate state right now - no client sends audio yet -
# and it must be reported rather than either crashed on or silently treated as "no files".
# The difference matters: "the directory is not there" and "the directory is empty" have
# different fixes, and only one of them is normal after uploads have started.
MEDIA_STATE="$("${SSH[@]}" "test -d '$MEDIA_DIR' && echo present || echo absent")"

if [ "$MEDIA_STATE" = "absent" ]; then
  if [ "$REQUIRE_MEDIA" = "1" ]; then
    # No warning and no set: once audio persistence is live, a database-only backup that
    # exits 0 is worse than no backup, because nobody goes looking for the recordings
    # until the day they need them.
    fail "$VPS:$MEDIA_DIR does not exist and MCL_BACKUP_REQUIRE_MEDIA=1"
  fi

  MEDIA_FILES=0
  echo "warning: $VPS:$MEDIA_DIR does not exist - no media stream in this set" >&2
  echo "         expected until AVALORIA_MEDIA_DIR is configured; see docs/ops/MCL-49-audio-storage.md" >&2
else
  # The manifest FIRST and on the VPS, so it describes the source rather than the copy.
  # Paths are made relative with `cd`, so `shasum -c` works from any restore directory
  # instead of only from one that reproduces the VPS's absolute layout.
  "${SSH[@]}" "cd '$MEDIA_DIR' && find . -type f -exec sha256sum {} + | sort -k2" \
    > "$MEDIA_MANIFEST"

  # -C so the archive holds relative paths for the same reason.
  "${SSH[@]}" "tar -cf - -C '$MEDIA_DIR' ." > "$MEDIA_TAR"

  MEDIA_FILES="$(wc -l < "$MEDIA_MANIFEST" | tr -d ' ')"

  # A tar that cannot be listed is not a backup either. Counted rather than eyeballed, and
  # compared with the manifest: a mismatch means the tree changed under the two commands
  # or the transfer lost entries, and both are worth failing on while the source is still
  # there to re-read.
  TAR_FILES="$(tar -tf "$MEDIA_TAR" | grep -cv '/$' || true)"
  if [ "$TAR_FILES" != "$MEDIA_FILES" ]; then
    mv "$MEDIA_TAR" "$MEDIA_TAR.corrupt"
    fail "media archive holds $TAR_FILES file(s), manifest lists $MEDIA_FILES"
  fi

  # THE PROOF, and the reason the two checks above are not it. A listable archive with the
  # right number of entries says nothing about content: a transfer that corrupted bytes
  # inside a recording, or truncated one while keeping its entry, passes both. This checks
  # the transferred BYTES against the manifest taken at the source, in a temporary tree
  # that the verifier removes on every exit path. Nothing in this set and nothing in
  # production is written by it.
  #
  # Before the prune below, deliberately: pruning on the strength of an unverified archive
  # is how the last good copy gets deleted.
  if ! "$SCRIPT_DIR/verify-media-archive.sh" "$MEDIA_TAR" "$MEDIA_MANIFEST"; then
    # Preserved under a name that cannot be mistaken for a backup, like a dump that
    # pg_restore could not read. The bytes are kept: they are evidence about what the
    # transfer did, and the manifest beside them is what proves it.
    mv "$MEDIA_TAR" "$MEDIA_TAR.corrupt"
    fail "media archive does not match its source manifest - quarantined as $MEDIA_TAR.corrupt"
  fi
fi

# --------------------------------------------------------------------------------------
# Prune only AFTER a new set has been taken and verified. Pruning first would leave a
# window with no good copy at all.
# --------------------------------------------------------------------------------------
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +

# Scripts in this repository report what they applied. The numbers are the point: a run
# that says "ok" and nothing else cannot be told from a run that copied an empty database.
DUMP_BYTES="$(wc -c < "$DUMP" | tr -d ' ')"
echo "ok: $(date -u +%FT%TZ) set $SET"
echo "    database: $DUMP ($DUMP_BYTES bytes, $(grep -c . "$DUMP.toc") TOC entries)"
if [ "$MEDIA_STATE" = "absent" ]; then
  echo "    media:    none - $MEDIA_DIR does not exist on $VPS"
else
  echo "    media:    $MEDIA_TAR ($(wc -c < "$MEDIA_TAR" | tr -d ' ') bytes, $MEDIA_FILES file(s))"
  echo "    manifest: $MEDIA_MANIFEST ($MEDIA_FILES line(s))"
fi
