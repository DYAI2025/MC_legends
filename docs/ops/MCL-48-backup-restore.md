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

**2. The external target is DECIDED: this MacBook pulls from the VPS.**

Benjamin's decision, 2026-08-14. The app keeps running **exclusively** on
`srv1308064.hstgr.cloud` (`https://srv1308064.hstgr.cloud:8443/#frage`); there is no second
host serving it and none is planned here. The backup is pulled **from this MacBook**
(user `benjaminpoersch`) directly from the VPS over ssh — `ssh root@76.13.130.224`.

The Berlin Linux machine (`dyai@100.103.64.33`), which earlier drafts named as the puller,
is **switched off** and is therefore not available as a backup host. The *shape* of the
design is unchanged — it is still a pull, and every argument in "Why pull" below still
holds unaltered. Only the machine changed.

One property the Berlin box had and this one does not: it was always on. A laptop is not.
That is handled in §2, honestly and with its cost stated, rather than assumed away.

**3. Jira MCL-48's backup criterion is NOT met by this document.**

The criterion is "backup/restore documented **and validated at least once**, restorable
off this VPS". Documented is half. It is met when the drill in §3 has actually been run
and its row is filled in in §4 — not before. Deciding the target does not move this, and
neither does merging this file. The table below deliberately ships with a
single `pending first drill` row so that the gap is visible rather than implied.

---

## The network path — this does **not** go over Tailscale

Written down because the connection was assumed to be a Tailscale link and it is not.
Verified from this MacBook on 2026-08-14:

```
$ dig +short srv1308064.hstgr.cloud
76.13.130.224

$ ssh root@76.13.130.224 'echo $SSH_CONNECTION ...'
server sees client IP: 79.206.188.35
server sshd bound:     76.13.130.224

$ tailscale status | grep -i srv1308064
100.115.155.7  srv1308064-1   DYAI2025@  linux  offline, last seen 12d ago
100.65.173.89  srv1308064     DYAI2025@  linux  offline, last seen 192d ago
```

`76.13.130.224` is the VPS's **public** IP — it is the A record for
`srv1308064.hstgr.cloud`, and it is not inside Tailscale's `100.64.0.0/10` range. The
VPS's two Tailscale nodes are **both offline** (last seen 12 days and 192 days ago). The
ssh that works goes over the public internet to port 22, which ufw already allows.

Three reasons this matters:

1. **The dump crosses the public internet.** ssh encrypts it in transit, so this is
   acceptable and the design stands. But "encrypted end to end over the public internet"
   is a different statement from "it never leaves a private network", and this document
   does not claim the latter.
2. **Nobody should go looking for a Tailscale link that is not carrying this traffic.** A
   future reader debugging a failed pull would otherwise spend time on a layer that is not
   involved.
3. **If the VPS's Tailscale node is ever brought back online, pointing the pull at the
   `100.x` address is a one-line change** — the `VPS=` line in the script below — and it
   would be a genuine improvement: the dump would leave the public internet entirely, and
   port 22 could then be closed to the world. Worth doing if the node comes back. Not a
   requirement; the backup is correct without it.

---

## Why pull, not push

This MacBook opens an ssh connection to the VPS, runs `pg_dump` there, and writes the
output to its own disk. The VPS never initiates anything.

That direction is the whole security argument:

- **The VPS stores no backup credential.** There is no ssh key, no rclone token, no S3
  secret on the box. An attacker who owns the VPS finds nothing that points at the copies.
- **The VPS opens no inbound port.** ufw stays at 22/80/443/8443. The backup adds no
  listening surface — the same reasoning that put the app on a Unix socket.
- **A compromised VPS cannot reach, corrupt or delete the copies.** With push-based
  backups it could: whatever credential lets the VPS write to the destination also lets an
  attacker on the VPS overwrite or erase what is stored there. Ransomware relies on
  exactly that. Pull inverts it.
- **No secret travels in either direction.** Only the dump crosses the wire, inside ssh —
  over the public internet, as recorded above. The `mcl_app` password stays in
  `/opt/mc-legends/app.env` and is never needed here: `pg_dump` runs on the VPS as the
  `postgres` peer-authenticated OS user.

The cost is that this MacBook must be awake and online when the schedule fires. On a
laptop that is not always true — see §2. For a family project whose data is a few
kilobytes of text, that is still the right trade.

---

## 1. The pull script (runs on this MacBook)

Not yet installed — this is the artefact to create.

Place at `~/bin/mcl-backup.sh` on this machine (user `benjaminpoersch`), mode `0700`.
Dumps go to `~/Backups/mc-legends` — outside the repository and outside `Downloads`, both
of which get cleaned out.

```bash
#!/usr/bin/env bash
# Pulls a dump of the MC Legends `mcl` database from the VPS to this machine.
# Runs HERE, not on the VPS: the VPS holds no credential for this machine and opens
# no inbound port, so a compromised VPS cannot reach or delete these copies.
set -euo pipefail

# launchd starts jobs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that contains no
# Homebrew. Set it explicitly, or the job works by hand and fails only when it runs
# unattended - the worst possible moment to find out. Must be PostgreSQL >= 17: see the
# version blocker below.
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

VPS="root@srv1308064.hstgr.cloud"   # public DNS -> 76.13.130.224, plain internet, not Tailscale
DEST="$HOME/Backups/mc-legends"
KEEP_DAYS=90
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$DEST/mcl-$STAMP.dump"

mkdir -p "$DEST"

# --format=custom, not plain SQL: it is compressed, and pg_restore can list, filter and
# restore selectively from it - which is what makes the verification below possible.
# --no-owner so the dump can be restored into a scratch database owned by whoever is
# running the drill, without needing an mcl_app role to exist on the restoring machine.
# BatchMode=yes so an unattended run fails immediately instead of hanging forever on a
# passphrase or host-key prompt that nobody is sitting there to answer.
ssh -o BatchMode=yes "$VPS" \
  "sudo -u postgres pg_dump --format=custom --no-owner --dbname=mcl" > "$DUMP"

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

echo "ok: $(date -u +%FT%TZ) $DUMP ($(stat -f %z "$DUMP") bytes)"
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
- `stat -f %z` is BSD/macOS `stat`. On Linux the same thing is `stat -c %s` — the earlier
  Berlin-targeted draft used the Linux spelling; this one runs on macOS.
- The timestamped filename means every run produces a new file and no run ever overwrites
  a previous good dump.

### Toolchain: RESOLVED 2026-08-14 — but read the port note

The version skew that used to block this is gone. `brew install postgresql@17` has been
run on this Mac, and all four preconditions are now verified rather than assumed.

The skew was real, and worth recording so nobody removes the explicit PATH line thinking
it is decoration. The VPS runs **PostgreSQL 17.10**; this Mac also has **15.18** installed
(`/opt/homebrew/opt/postgresql@15/bin`), and `pg_restore` 15 **cannot** read a
custom-format archive written by `pg_dump` 17. Proven against a real dump pulled from the
VPS:

```
$ /opt/homebrew/opt/postgresql@15/bin/pg_restore --list mcl-probe.dump
pg_restore: Fehler: nicht unterstützte Version (1.16) im Dateikopf

$ /opt/homebrew/opt/postgresql@17/bin/pg_restore --list mcl-probe.dump
pg_restore (PostgreSQL) 17.11 (Homebrew)
; Archive created at 2026-08-14 01:08:02 CEST
;     dbname: postgres
;     TOC Entries: 5
```

That would have broken the pull script's **own** `pg_restore --list` verification on every
single run — quarantining every dump as `.corrupt` — not merely the drill. Both formulae
are keg-only and neither is linked into `PATH`, so whichever `pg_restore` the shell happens
to find is not something to rely on. **Keep the explicit
`/opt/homebrew/opt/postgresql@17/bin` PATH line in the script and in the drill.**

**Preconditions, all verified 2026-08-14:**

1. **Client tools ≥ 17** — `/opt/homebrew/opt/postgresql@17/bin/pg_restore --version` →
   `pg_restore (PostgreSQL) 17.11 (Homebrew)`. ✅
2. **Passphrase-free ssh key** — `ssh -o BatchMode=yes root@76.13.130.224` succeeds
   without a prompt, so a launchd job that inherits no unlocked `ssh-agent` will work. ✅
3. **`pg_dump` on the VPS** — `pg_dump (PostgreSQL) 17.10`, matching its server. ✅
4. **A local server ≥ 17 for the drill** — `brew install postgresql@17` created a cluster
   at `/opt/homebrew/var/postgresql@17`. It is **not** running by default, which is
   deliberate; see the port note. ✅

#### Port note: 5432 belongs to the 15 cluster

`postgresql@15` is running on the default port **5432** and holds `mcl_test`, the database
the repository's integration tests use. Do **not** `brew services start postgresql@17` —
it would take 5432 and the two clusters would fight over it.

Start the 17 cluster on another port only for the duration of a drill, then stop it:

```bash
P17=/opt/homebrew/opt/postgresql@17/bin
"$P17"/pg_ctl -D /opt/homebrew/var/postgresql@17 -o "-p 5433" -l /tmp/pg17.log start
# ... run the drill in §3 against -p 5433 ...
"$P17"/pg_ctl -D /opt/homebrew/var/postgresql@17 stop
```

The whole mechanic — pull a custom-format dump from the VPS, `createdb` a scratch database
on the 17 cluster, `pg_restore --exit-on-error` into it, query it, `dropdb`, stop the
server — was exercised end to end on 2026-08-14 and works. What has **not** been done is
the drill against the real `mcl` database, because `mcl` does not exist on the VPS yet:
provisioning is a separate human-triggered step in
`docs/deploy/vps-mc-legends.md`. The Jira criterion stays open until that runs. See §4.

---

## 2. Scheduling (launchd `LaunchAgent` on this MacBook)

macOS has no systemd. The per-user equivalent of a timer is a `LaunchAgent` plist under
`~/Library/LaunchAgents/`.

`~/Library/LaunchAgents/com.dyai.mcl-backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dyai.mcl-backup</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/benjaminpoersch/bin/mcl-backup.sh</string>
  </array>

  <!-- Daily at 13:00 local time. If the Mac is asleep at 13:00, launchd runs the job
       when it next wakes. If the Mac was powered OFF, the missed calendar run is not
       made up - RunAtLoad below is what covers that case. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>   <integer>13</integer>
    <key>Minute</key> <integer>0</integer>
  </dict>

  <!-- Runs the job when the agent is loaded, i.e. at every login. Together with the
       calendar entry this is what makes a missed window get caught the next time the
       machine is actually awake, instead of skipped until tomorrow. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- There is no journal on macOS. Keep stdout and stderr somewhere readable. -->
  <key>StandardOutPath</key>
  <string>/Users/benjaminpoersch/Backups/mc-legends/backup.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/benjaminpoersch/Backups/mc-legends/backup.log</string>
</dict>
</plist>
```

launchd does **not** expand `~` inside a plist — the absolute paths above are deliberate,
and the `$HOME`-relative paths in the script are fine because the script is a shell.

Load it, and prove it can run rather than assuming:

```bash
mkdir -p ~/Backups/mc-legends
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dyai.mcl-backup.plist
launchctl kickstart -p gui/$(id -u)/com.dyai.mcl-backup   # run it once now, deliberately
launchctl print gui/$(id -u)/com.dyai.mcl-backup | head -20
tail -20 ~/Backups/mc-legends/backup.log
```

(To remove or reload it: `launchctl bootout gui/$(id -u)/com.dyai.mcl-backup`. The older
`launchctl load`/`unload` spelling still works but is deprecated.)

The cost of `RunAtLoad` is a handful of extra dumps on days with several logins. They are
timestamped, a few kilobytes each, and pruned after `KEEP_DAYS`. Trading a little disk for
"the machine backs up soon after it is awake" is the right way round.

### A missed window is normal on a laptop, not a fault

The Berlin box was always on. **This one is not.** A scheduled pull on a MacBook is
best-effort by nature: it does not run while the lid is shut, while the machine is asleep,
while it is powered off, or while it is off the network. Nothing here changes that, and a
skipped day is expected behaviour rather than something to debug.

What that costs is stated in §5: the worst-case data loss is everything submitted since
the last successful pull, and on a laptop that gap can be longer than 24 hours.

### Telling "no backup ran" apart from "backups are fine"

Because the runs are irregular, "when did it last succeed?" cannot be answered by looking
at a schedule. Look at the newest dump instead:

```bash
f=$(ls -t ~/Backups/mc-legends/mcl-*.dump 2>/dev/null | head -1); \
[ -n "$f" ] && echo "$(basename "$f") — $(( ($(date +%s) - $(stat -f %m "$f")) / 3600 ))h old" \
            || echo "NO DUMPS AT ALL"
```

Worth an alias. How to read it:

- **A few hours to ~2 days old** — normal. The laptop has been used and the job has run.
- **Older than about a week** — the schedule is not firing, or the script is failing every
  time. Read `~/Backups/mc-legends/backup.log` and look for `.corrupt` files in the dump
  directory, then run `launchctl kickstart` by hand and watch it.
- **`NO DUMPS AT ALL`** — nothing has ever worked. Go back to the TODO list in §1.

That is the whole check. There is deliberately no monitoring system here; see the
"does not cover" list.

---

## 3. Restore drill — into a scratch database, never over `mcl`

The drill is the part that turns this document from a plan into a met acceptance
criterion.

**Never restore over `mcl`.** `pg_restore` into the live database can drop and recreate
objects, and a restore of a stale dump over live data destroys every submission received
since that dump was taken. The drill exists to prove the dump is good, not to overwrite
anything.

Run on this MacBook, against its own local PostgreSQL. Only the two source-count queries
at the end touch the VPS, and they are read-only.

The toolchain for this is in place as of 2026-08-14 (§1) and the mechanic has been
exercised end to end. What is still missing is the **subject**: the `mcl` database does not
exist on the VPS yet, so there is nothing real to dump. Run this drill immediately after
provisioning and the first deploy, and record the result in §4.

Every command below runs on the 17 cluster on port **5433**, because the 15 cluster owns
5432 and holds the repository's `mcl_test` — see the port note in §1. Start the server
first, and stop it when you are done.

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"   # >= 17, see §1
export PGPORT=5433                                        # the 17 cluster; 15 owns 5432

pg_ctl -D /opt/homebrew/var/postgresql@17 -o "-p 5433" -l /tmp/pg17.log start

DUMP=~/Backups/mc-legends/mcl-<stamp>.dump
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

# 5. Stop the 17 cluster again, so it cannot drift into competing with the 15 one.
pg_ctl -D /opt/homebrew/var/postgresql@17 stop
```

**Pass condition.** The restored `count(*)` equals the source count **as of the moment the
dump was taken** — if submissions arrived in between, the restored count is lower by
exactly that many and that is correct, not a failure; record both numbers and the
difference. The `schema_migrations` rows must match **exactly**: a dump whose migrations
differ from the source's is a dump that would restore a different schema than the app
expects.

**Fail condition.** Anything else. A failed drill means the backup does not work, whatever
the scheduled job's exit code has been saying — record it in the table below and fix it
before calling the criterion met.

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
  The recovery granularity is one dump per successful run, so the worst-case data loss is
  everything submitted since the last successful pull. With the puller being a laptop that
  is **not bounded by 24 hours** — it is however long the machine was asleep, off, or off
  the network (§2). For a family project that is an accepted trade; it is not a property
  to discover during an incident. Adding PITR
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
- **Alerting.** Nothing notifies anyone when the schedule stops firing or a dump fails
  verification. The only current check is a human running the dump-age one-liner in §2 and
  reading `~/Backups/mc-legends/backup.log`. Worth its own ticket. It matters more here
  than it would have on an always-on machine, because on a laptop "no run today" is
  indistinguishable from "broken" without looking.
- **A second copy of the dumps.** Everything lives on one laptop's disk. That is already
  strictly better than today (where it lives only on the VPS), but a lost or stolen
  MacBook loses the backups. An encrypted off-machine copy is a separate decision.
