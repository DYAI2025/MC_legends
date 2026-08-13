# MCL-48 — Backup and restore for the `mcl` database

Companion to `docs/deploy/vps-mc-legends.md`. That document gets the data into
PostgreSQL; this one is about getting it back out when something goes wrong.

---

## Status — read this before anything else

**1. There is no working backup of anything on `srv1308064.hstgr.cloud` today.**

Verified read-only on 2026-08-13:

- `restic`, `borg`, `rclone`, `pgbackrest`, `wal-g`, `duplicity`,
  `autopostgresqlbackup` — **all absent**.
- `rclone` has **no remotes configured**, so there is no destination to send anything to.
- The root crontab contains `0 3 * * * /opt/openfang/scripts/backup.sh`. **That script does
  not exist.** The only backup-looking entry on the box has been doing nothing, silently,
  for as long as it has been there.
- `/var/backups` holds nothing but dpkg/apt rotation artefacts — package metadata, not
  data.

This is not only about MCL-48. The `gbrain` database (44 MB), the `AVALORIA_*` secrets and
every other service on that host are equally unbacked. MCL-48 fixes exactly one slice of
that — the `mcl` database — and leaves the rest as it found it.

**2. The external target is an OPEN DECISION, not yet confirmed by Benjamin.**

The rest of this document is written against the **recommended default**: the Berlin Linux
machine (`dyai@100.103.64.33`, reachable over Tailscale) **pulls** dumps from the VPS.
Reasoning is in "Why pull" below. Confirm or override that choice before implementing any
of it. Nothing in `docs/deploy/vps-mc-legends.md` depends on the answer.

**3. Jira MCL-48's backup criterion is NOT met by this document.**

The criterion is "backup/restore documented **and validated at least once**, restorable
off this VPS". Documented is half. It is met when the drill in §4 has actually been run
and its row is filled in in §5 — not before. The table below deliberately ships with a
single `pending first drill` row so that the gap is visible rather than implied.

---

## Why pull, not push

The Berlin machine opens an ssh connection to the VPS, runs `pg_dump` there, and writes
the output to its own disk. The VPS never initiates anything.

That direction is the whole security argument:

- **The VPS stores no backup credential.** There is no ssh key, no rclone token, no S3
  secret on the box. An attacker who owns the VPS finds nothing that points at the copies.
- **The VPS opens no inbound port.** ufw stays at 22/80/443/8443. The backup adds no
  listening surface — the same reasoning that put the app on a Unix socket.
- **A compromised VPS cannot reach, corrupt or delete the copies.** With push-based
  backups it could: whatever credential lets the VPS write to the destination also lets an
  attacker on the VPS overwrite or erase what is stored there. Ransomware relies on
  exactly that. Pull inverts it.
- **No secret travels in either direction.** Only the dump crosses the wire, over ssh,
  over Tailscale. The `mcl_app` password stays in `/opt/mc-legends/app.env` and is never
  needed here — `pg_dump` runs on the VPS as the `postgres` peer-authenticated OS user.

The cost is that the Berlin machine must be up when the timer fires. For a family project
whose data is a few kilobytes of text, that is the right trade.

---

## 1. The pull script (runs on the Berlin machine)

Not yet installed — this is the artefact to create once the target is confirmed.

Place at `~/bin/mcl-backup.sh` on `dyai@100.103.64.33`, mode `0700`.

```bash
#!/usr/bin/env bash
# Pulls a dump of the MC Legends `mcl` database from the VPS to this machine.
# Runs HERE, not on the VPS: the VPS holds no credential for this machine and opens
# no inbound port, so a compromised VPS cannot reach or delete these copies.
set -euo pipefail

VPS="root@srv1308064.hstgr.cloud"
DEST="$HOME/backups/mc-legends"
KEEP_DAYS=90
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$DEST/mcl-$STAMP.dump"

mkdir -p "$DEST"

# --format=custom, not plain SQL: it is compressed, and pg_restore can list, filter and
# restore selectively from it - which is what makes the verification below possible.
# --no-owner so the dump can be restored into a scratch database owned by whoever is
# running the drill, without needing an mcl_app role to exist on the restoring machine.
ssh "$VPS" "sudo -u postgres pg_dump --format=custom --no-owner --dbname=mcl" > "$DUMP"

# Verify at BACKUP time, not during an incident. A dump that pg_restore cannot list is
# not a backup - it is a file. This catches a truncated transfer, a half-written dump and
# a silently failed ssh, at the moment they happen and while the source still exists.
if ! pg_restore --list "$DUMP" > "$DUMP.toc"; then
  echo "FAILED: pg_restore --list could not read $DUMP" >&2
  mv "$DUMP" "$DUMP.corrupt"
  exit 1
fi

# A listable but empty dump is also a failure - it means pg_dump connected to the wrong
# database or the table vanished.
if ! grep -q 'submission_inbox' "$DUMP.toc"; then
  echo "FAILED: $DUMP contains no submission_inbox" >&2
  mv "$DUMP" "$DUMP.corrupt"
  exit 1
fi

# Prune only AFTER a new dump has been taken and verified. Pruning first would leave a
# window with no good copy at all.
find "$DEST" -name 'mcl-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'mcl-*.dump.toc' -mtime "+$KEEP_DAYS" -delete

echo "ok: $DUMP ($(stat -c %s "$DUMP") bytes)"
```

Notes on the choices:

- `--format=custom` rather than plain SQL, because `pg_restore --list` on a custom dump is
  a real structural read of the file. On a plain-SQL dump there is nothing equivalent to
  check short of restoring it.
- `--no-owner` because the drill restores into a scratch database owned by the person
  running the drill. Without it, `pg_restore` emits `ALTER … OWNER TO mcl_app` and fails
  wherever that role does not exist.
- The failed dump is renamed `.corrupt` rather than deleted, so there is something to look
  at afterwards, and so the next run does not silently overwrite the evidence.
- `stat -c %s` is GNU `stat` (Linux). On macOS it is `stat -f %z`.

> **TODO before first use:** confirm that `root@srv1308064.hstgr.cloud` is reachable from
> the Berlin machine over Tailscale with key-based ssh and no passphrase prompt — a key
> with a passphrase cannot be used from a timer. Confirm `pg_dump` on the VPS is version
> 17.x (it must be ≥ the server's 17.10) and that the Berlin machine's `pg_restore` is
> also ≥ 17, since a newer custom-format dump cannot be read by an older `pg_restore`.

---

## 2. Scheduling (systemd timer on the Berlin machine)

A timer, not cron: a timer records the last run, survives a machine that was asleep at the
scheduled minute (`Persistent=true`), and its failures land in the journal instead of in
root's mail spool.

`~/.config/systemd/user/mcl-backup.service`:

```ini
[Unit]
Description=Pull a PostgreSQL dump of the MC Legends inbox from the VPS

[Service]
Type=oneshot
ExecStart=%h/bin/mcl-backup.sh
```

`~/.config/systemd/user/mcl-backup.timer`:

```ini
[Unit]
Description=Daily MC Legends inbox backup

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now mcl-backup.timer
loginctl enable-linger dyai        # so the timer runs without an active login session
systemctl --user list-timers mcl-backup.timer
```

Check it is actually running, rather than assuming:

```bash
systemctl --user status mcl-backup.service     # expect the last run to have succeeded
journalctl --user -u mcl-backup.service -n 20
ls -lt ~/backups/mc-legends | head
```

A timer whose last successful run is older than two days is an incident, not a nit. There
is no alerting for that yet — see the "does not cover" list.

---

## 3. Restore drill — into a scratch database, never over `mcl`

The drill is the part that turns this document from a plan into a met acceptance
criterion.

**Never restore over `mcl`.** `pg_restore` into the live database can drop and recreate
objects, and a restore of a stale dump over live data destroys every submission received
since that dump was taken. The drill exists to prove the dump is good, not to overwrite
anything.

Run on the Berlin machine, against its own local PostgreSQL. Nothing here touches the VPS.

```bash
DUMP=~/backups/mc-legends/mcl-<stamp>.dump
SCRATCH=mcl_drill_$(date -u +%Y%m%d)

# 1. Create the scratch database
createdb "$SCRATCH"

# 2. Restore into it. --exit-on-error so a partial restore is a failure, not a warning.
pg_restore --dbname="$SCRATCH" --no-owner --exit-on-error "$DUMP"

# 3. Compare against the source. These two numbers are the whole drill.
psql -d "$SCRATCH" -Atc "select count(*) from submission_inbox;"
psql -d "$SCRATCH" -Atc "select version from schema_migrations order by version;"

ssh root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -d mcl -Atc 'select count(*) from submission_inbox;'"
ssh root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -d mcl -Atc 'select version from schema_migrations order by version;'"

# 4. Drop the scratch database. Do not leave a stale copy of family answers lying around.
dropdb "$SCRATCH"
```

**Pass condition.** The restored `count(*)` equals the source count **as of the moment the
dump was taken** — if submissions arrived in between, the restored count is lower by
exactly that many and that is correct, not a failure; record both numbers and the
difference. The `schema_migrations` rows must match **exactly**: a dump whose migrations
differ from the source's is a dump that would restore a different schema than the app
expects.

**Fail condition.** Anything else. A failed drill means the backup does not work, whatever
the timer's exit code has been saying — record it in the table below and fix it before
calling the criterion met.

Do the drill on a **freshly pulled dump**, not on one you have already used. The thing
being tested is the pipeline, not one file.

---

## 4. Drill record

Every drill gets a row. A drill that is not written down did not happen.

| Date (UTC) | Dump file | Dump size | Rows restored | Rows at source | `schema_migrations` restored | Match | Run by |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | **pending first drill** | — |

The criterion in Jira MCL-48 is "validated at least once". This table has **no completed
row**, so the criterion is **not met**. It becomes met when a real drill fills in the first
row — not when this document is merged.

---

## 5. What this explicitly does not cover

Stated so nobody assumes coverage that does not exist.

- **Point-in-time recovery.** There is **no WAL archiving** and none is configured here.
  The recovery granularity is one daily dump, so the worst-case data loss is everything
  submitted since the last successful pull — up to 24 hours. For a family project that is
  an accepted trade; it is not a property to discover during an incident. Adding PITR
  means `archive_mode`, an archive destination and a base backup, and it would apply to
  the whole server including `gbrain` — a separate decision, not a footnote to this one.
- **The `AVALORIA_*` secrets.** `/opt/mc-legends/app.env` holds the family access code,
  the session secret and now the `DATABASE_URL` password. **None of them are in these
  dumps.** Losing the VPS therefore loses those values, and every family session would be
  invalidated when they are regenerated. Keep them in a password manager. Do **not** add
  the file to this backup: it would put the database password in the same place as the
  database, which is exactly what the "no secret travels" property above avoids.
- **Audio artefacts (MCL-49).** Not yet in existence, and `pg_dump` of `mcl` will not
  cover blobs stored on the filesystem. When MCL-49 lands, this document needs a second
  stream for those files, and §12 of `docs/deploy/vps-mc-legends.md` (disk at 78 %) needs
  revisiting for both the source volume and the backup destination.
- **Every other service on the VPS.** `gbrain`, `openwa-postgres`, `whatsapp-brain`,
  `lpam-frontend-1`, `qdrant`, nginx configuration, Let's Encrypt certificates. All still
  unbacked, all out of MCL-48's scope, all deliberately untouched by this work.
- **Alerting.** Nothing notifies anyone when the timer stops running or a dump fails
  verification. The only current check is a human reading `systemctl --user list-timers`.
  Worth its own ticket once the target is confirmed.
