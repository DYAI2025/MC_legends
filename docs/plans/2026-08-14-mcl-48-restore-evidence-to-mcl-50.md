# MCL-48 Real Restore Evidence → MCL-50 Protected Inbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close MCL-48's one open acceptance criterion with a real, recorded off-VPS restore drill of the production `mcl` database, merge the evidence, reconcile Jira/Confluence, and only then begin MCL-50 (protected family/admin inbox read) on a fresh branch.

**Architecture:** The drill is an operational exercise producing a *documentation-only* repository change (`docs/ops/MCL-48-backup-restore.md` §4 drill record). MCL-50 adds a read side behind the existing ports/adapters boundary: a new `SubmissionInboxReader` port in `src/application`, implemented by the existing PostgreSQL and file adapters, exposed through a `GET /api/admin/inbox/submissions` route guarded by a **separate admin credential** (not the child write-session), and rendered by a server component. React never touches PostgreSQL.

**Tech Stack:** Next.js 16.3 (App Router), React 19.2, TypeScript 6.0, `pg` 8.16.3, Vitest 4.1, Playwright 1.62, PostgreSQL 17 (VPS 17.10, local drill cluster 17.11), Node ≥ 24.18.1 < 25.

---

## Baseline established 2026-08-14 (read-only, already verified)

Do **not** re-derive these; they were checked before this plan was written. Do re-check anything marked *(re-verify)*.

| Fact | Value | Source |
|---|---|---|
| `origin/main` | `bf130869ed79b478c48ecdb3c6c01b3a13ff6916` | `git rev-parse origin/main` |
| Local HEAD | `29565996fd05db81fd1c0a7a5a581b9208d2669b` ("first commit") | `git rev-parse HEAD` |
| Local vs origin | **58 behind, 0 ahead** | `git rev-list --count` |
| Local dirty | `M AGENTS.md`, `M next-env.d.ts`, `?? .claude/`, `?? docs/plans/`, `?? package-lock.json` | `git status --short` |
| MCL-48 Jira status | `In Arbeit`, 9 acceptance criteria, backup criterion unchanged | `getJiraIssue MCL-48` |
| MCL-50 Jira status | `Zu erledigen`, 8 acceptance criteria | `getJiraIssue MCL-50` |
| Jira cloudId | `4504291c-8bc0-48f8-ab9e-9ad5d376ca04` (`dyai2026.atlassian.net`) | `getAccessibleAtlassianResources` |
| `~/bin/mcl-backup.sh` | **does not exist** | `ls` |
| `~/Backups/mc-legends/` | **does not exist** | `ls` |
| `~/Library/LaunchAgents/com.dyai.mcl-backup.plist` | **does not exist** | `ls` |
| Local `pg_restore` 17 | `pg_restore (PostgreSQL) 17.11 (Homebrew)` | `--version` |
| PG17 cluster dir | `/opt/homebrew/var/postgresql@17` exists, not running | `ls` |
| Runbook §4 drill table | one row: `pending first drill` | `git show origin/main:docs/ops/MCL-48-backup-restore.md` |
| VPS `mcl` database exists | **UNVERIFIED** *(re-verify — runbook says it did not exist when written)* | — |

**The material gap this plan closes:** the runbook documents a pull script that *has never been created*, and records a drill that *has never been run*. Both must become real before MCL-48 can move to `Fertig`.

---

## Hard rules for this plan

- Verification results use **only** `PASS` / `FAIL` / `not_run: <reason>` / `BLOCKED`. Never infer a PASS.
- Never print child submission text, secrets, passwords, or full connection strings with credentials.
- Never restore over `mcl`. Scratch databases only.
- Never `brew services start postgresql@17` — port 5432 belongs to the `postgresql@15` cluster holding `mcl_test`.
- Do not commit directly to `main`. Branch + PR (`AGENTS.md`).
- Stop and report if any stop condition in Task 3 or Task 6 trips.

---

## Phase 0 — Workspace sync

### Task 0: Bring the working tree to `origin/main`

**Files:**
- Modify: working tree only (no committed change)

**Step 1: Confirm nothing local is worth keeping**

```bash
cd /Users/benjaminpoersch/Downloads/MC_legends-bootstrap
git diff --stat
git diff -- AGENTS.md | head -40
```

Expected: only the machine-regenerated 10-line block in `AGENTS.md` and the Next.js-regenerated `next-env.d.ts`. Both are self-regenerating build artifacts — discarding them loses no work.

**Step 2: Sync to `origin/main`**

```bash
git fetch --all --prune
git checkout -B main origin/main
git reset --hard origin/main
git rev-parse HEAD
```

Expected output of the last command, exactly:

```
bf130869ed79b478c48ecdb3c6c01b3a13ff6916
```

If it is anything else → **BLOCKED: current main differs materially from the stated baseline.** Stop and report.

Untracked files (`.claude/`, `docs/plans/*.md`, `package-lock.json`) survive `reset --hard`. Do not `git clean`.

**Step 3: Confirm the runbook is now on disk**

```bash
test -f docs/ops/MCL-48-backup-restore.md && echo PRESENT || echo MISSING
test -f docs/deploy/vps-mc-legends.md && echo PRESENT || echo MISSING
```

Expected: `PRESENT` twice.

**Step 4: Pin the Node version**

```bash
source ~/.nvm/nvm.sh && nvm use 24.18.1 && node --version
```

Expected: `v24.18.1`. The default shell Node (24.16.0) fails `npm ci` against `engines`.

**Step 5: Install dependencies**

```bash
npm ci
```

Expected: completes without an `EBADENGINE` error.

**No commit.** This task changes nothing tracked.

---

## Phase 1 — Production pre-flight (read-only)

### Task 1: Re-verify the production baseline

**Files:** none. Read-only.

**Step 1: Confirm the app is up**

```bash
curl -sk https://srv1308064.hstgr.cloud:8443/api/health
curl -sk https://srv1308064.hstgr.cloud:8443/api/health/ready
```

Expected: `/api/health` reports OK; `/api/health/ready` reports application **and** database separately, both OK. Record the raw JSON verbatim in the final report.

If `/api/health/ready` reports the database as anything but OK → **BLOCKED**. Do not proceed to the drill; a dump of a database the app cannot reach proves nothing about the running system.

**Step 2: Confirm the `mcl` database and its server version exist**

```bash
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -Atc \"select current_setting('server_version');\" && \
   sudo -u postgres psql -Atlc \"select datname from pg_database where datname='mcl';\""
```

Expected: a version string beginning `17.` and the single line `mcl`.

If `mcl` is absent → **BLOCKED: the drill has no subject.** The runbook records that provisioning is a separate human-triggered step in `docs/deploy/vps-mc-legends.md`. Report and stop; MCL-48 stays `In Arbeit`.

**Step 3: Confirm PostgreSQL is not publicly exposed**

```bash
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "ss -lntp | grep -E ':5432' || echo 'no tcp listener on 5432'"
```

Expected: either no TCP listener, or a listener bound to `127.0.0.1`/`::1` only. A `0.0.0.0:5432` line → **BLOCKED**, and it is also an MCL-48 acceptance-criterion regression.

**Step 4: Read the source counts (numbers only, no content)**

```bash
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -d mcl -Atc 'select count(*) from submission_inbox;'"
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -d mcl -Atc 'select version from schema_migrations order by version;'"
```

Record both. These are the pre-dump comparison point. **Never** `select original_text`.

**Step 5: Confirm the JSONL rollback state still exists**

```bash
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "ls -l /opt/mc-legends/data/inbox/submissions.jsonl 2>/dev/null || echo 'not present'"
```

Record the result either way. Its absence is not a blocker; its presence is the documented rollback path and worth confirming.

**No commit.**

---

## Phase 2 — Approval gate

### Task 2: Obtain explicit approval before any production data leaves the VPS

**Step 1: Ask, verbatim, and stop**

Print exactly this and wait for a human answer:

```
The remaining MCL-48 acceptance test requires copying a real mcl backup
from the VPS to this Mac temporarily for an isolated restore drill.
Proceed?
```

Do not proceed on inference, on a prior session's approval, or on the presence of this plan. Approval must be given **in the executing session**, unless it is already explicit in the immediately preceding user instruction.

If refused → report `BLOCKED: approval withheld`, MCL-48 stays `In Arbeit`, and **do not** start MCL-50 (WIP limit 1).

**No commit.**

---

## Phase 3 — Create the pull script and take the real dump

### Task 3: Install the pull script from the runbook

**Files:**
- Create: `/Users/benjaminpoersch/bin/mcl-backup.sh` (outside the repository — never committed)

**Step 1: Create the destination directory**

```bash
mkdir -p ~/Backups/mc-legends ~/bin
```

**Step 2: Write the script exactly as `docs/ops/MCL-48-backup-restore.md` §1 specifies**

Copy the script body verbatim from the runbook. Do not re-derive it and do not "improve" it. The essential properties, each of which the runbook justifies:

- explicit `export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"` (launchd's minimal PATH has no Homebrew; PG15's `pg_restore` cannot read a PG17 custom archive)
- `ssh -o BatchMode=yes root@srv1308064.hstgr.cloud "sudo -u postgres pg_dump --format=custom --no-owner --dbname=mcl"` redirected to the dump file
- `pg_restore --list` verification at backup time, quarantining to `.corrupt` on failure
- `grep -q 'submission_inbox'` on the TOC, quarantining on failure
- prune **after** a verified new dump, never before
- `stat -f %z` (BSD/macOS spelling)

**Step 3: Make it executable and confirm the mode**

```bash
chmod 0700 ~/bin/mcl-backup.sh
stat -f '%Sp %N' ~/bin/mcl-backup.sh
```

Expected: `-rwx------ /Users/benjaminpoersch/bin/mcl-backup.sh`

**Step 4: Verify the script content actually reached disk**

```bash
grep -c 'postgresql@17/bin' ~/bin/mcl-backup.sh
grep -c 'BatchMode=yes' ~/bin/mcl-backup.sh
grep -c 'submission_inbox' ~/bin/mcl-backup.sh
```

Expected: each ≥ 1. (A scripted edit can be silently skipped by a hook while downstream checks pass on an unmodified file — check the mutation, not only its consequences.)

**No commit.** `~/bin` is outside the repository by design.

### Task 4: Take the first real dump

**Step 1: Run the script**

```bash
~/bin/mcl-backup.sh
```

Expected: a single `ok: <timestamp> /Users/benjaminpoersch/Backups/mc-legends/mcl-<STAMP>.dump (<N> bytes)` line, exit 0.

If it prints `FAILED:` or a `.corrupt` file appears → **BLOCKER: source backup cannot be produced consistently.** Record the exact error and stop.

**Step 2: Confirm the dump exists off the VPS**

```bash
ls -l ~/Backups/mc-legends/*.dump
```

Expected: exactly one `.dump` file with a non-zero size, on this Mac. Record its basename and byte size. This satisfies "backup must be restorable outside the single VPS".

**Step 3: Confirm the dump is not inside the repository and cannot be committed**

```bash
git -C /Users/benjaminpoersch/Downloads/MC_legends-bootstrap status --short | grep -i dump || echo "no dump in repo status"
```

Expected: `no dump in repo status`.

**Step 4: List the archive with PG17 tooling**

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_restore --list ~/Backups/mc-legends/mcl-<STAMP>.dump | head -20
```

Expected: a header naming `pg_restore (PostgreSQL) 17.x` and a TOC listing that includes `submission_inbox`. Record `PASS`/`FAIL`.

**No commit.**

---

## Phase 4 — The restore drill

### Task 5: Restore into a scratch database on the PG17 cluster

Follow `docs/ops/MCL-48-backup-restore.md` §3 exactly. Do not invent a second process.

**Step 1: Start the PG17 cluster on port 5433**

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
export PGPORT=5433
pg_ctl -D /opt/homebrew/var/postgresql@17 -o "-p 5433" -l /tmp/pg17.log start
```

Expected: `server started`. Confirm 5432 is untouched:

```bash
psql -p 5432 -Atc "select current_setting('server_version');" postgres
```

Expected: a `15.x` string — the PG15 cluster holding `mcl_test` is still the owner of 5432.

**Step 2: Create the scratch database**

```bash
SCRATCH=mcl_drill_$(date -u +%Y%m%d)
createdb "$SCRATCH"
psql -d "$SCRATCH" -Atc "select current_database();"
```

Expected: the scratch name echoed back.

**Step 3: Restore with `--exit-on-error`**

```bash
pg_restore --dbname="$SCRATCH" --no-owner --exit-on-error ~/Backups/mc-legends/mcl-<STAMP>.dump
echo "pg_restore exit: $?"
```

Expected: `pg_restore exit: 0` and no output. Any non-zero exit → **BLOCKER: restored counts/schema do not match** — record the error verbatim and go to Task 5b.

**Step 4: Verify the schema exists**

```bash
psql -d "$SCRATCH" -Atc "select tablename from pg_tables where schemaname='public' order by tablename;"
psql -d "$SCRATCH" -Atc "select column_name from information_schema.columns where table_name='submission_inbox' order by ordinal_position;"
```

Expected tables: at minimum `schema_migrations` and `submission_inbox`.
Expected columns, in order: `submission_id, kind, question_id, created_at, received_at, receipt_id, original_text, status, inserted_at`.

**Step 5: Verify the restored database is queryable, and count rows**

```bash
psql -d "$SCRATCH" -Atc "select count(*) from submission_inbox;"
psql -d "$SCRATCH" -Atc "select version from schema_migrations order by version;"
```

**Step 6: Read the source counts again, post-dump**

```bash
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -d mcl -Atc 'select count(*) from submission_inbox;'"
ssh -o BatchMode=yes root@srv1308064.hstgr.cloud \
  "sudo -u postgres psql -d mcl -Atc 'select version from schema_migrations order by version;'"
```

**Pass condition** (from the runbook, applied literally):
- restored `count(*)` equals the source count **as of the moment the dump was taken**. If submissions arrived between dump and comparison, the restored count is lower by exactly that many — record both numbers and the difference; that is correct, not a failure.
- `schema_migrations` rows must match **exactly**. Any difference → FAIL.

**Fail condition:** anything else.

**Step 7: Drop the scratch database**

```bash
dropdb "$SCRATCH"
psql -d postgres -Atlc "select datname from pg_database where datname like 'mcl_drill_%';" || true
```

Expected: no `mcl_drill_*` row remains. Record `PASS`/`FAIL`.

**Step 8: Stop the PG17 cluster**

```bash
pg_ctl -D /opt/homebrew/var/postgresql@17 stop
pg_isready -p 5433 || echo "5433 down as expected"
pg_isready -p 5432 && echo "5432 still up (PG15, correct)"
```

Expected: 5433 down, 5432 still up.

**No commit.**

### Task 5b: If the drill FAILS

Do not retry blindly and do not adjust the check to fit the result.

1. Record the exact failing command and its verbatim output.
2. Leave the `.corrupt`/failing artifacts in place as evidence.
3. Ensure cleanup still runs: `dropdb` the scratch database, `pg_ctl stop` the cluster.
4. Update `docs/ops/MCL-48-backup-restore.md` §4 with a **FAIL row** — a failed drill is still a drill and still gets written down.
5. Report the acceptable partial outcome: defect documented, MCL-48 stays `In Arbeit`, **MCL-50 not started**.
6. Skip to the final report. Do not execute Phase 6 or Phase 7.

---

## Phase 5 — Repository evidence

### Task 6: Branch and record the drill in the runbook

**Files:**
- Modify: `docs/ops/MCL-48-backup-restore.md`

**Step 1: Create a dedicated branch from current main**

```bash
git checkout -b docs/MCL-48-first-real-restore-drill origin/main
git rev-parse --abbrev-ref HEAD
```

Expected: `docs/MCL-48-first-real-restore-drill`. Do **not** reuse the merged PR #19 branch.

**Step 2: Replace the `pending first drill` row in §4**

Replace this row:

```markdown
| — | — | — | — | — | — | **pending first drill** | — |
```

with the real record (fill every column from Tasks 4–5; example shape only):

```markdown
| 2026-08-14T… | `mcl-<STAMP>.dump` | <N> bytes | <restored count> | <source count> | `0001` | **PASS** | Claude Code / benjaminpoersch |
```

**Step 3: Add a drill-detail block directly under the table**

```markdown
### First real drill — 2026-08-14

- Source: `srv1308064.hstgr.cloud`, PostgreSQL server major **17**
- Restore host: this MacBook, PostgreSQL **17.11** cluster on port 5433
- Dump: `pg_dump --format=custom --no-owner --dbname=mcl` over ssh, written to
  `~/Backups/mc-legends/` — outside the VPS and outside this repository
- `pg_restore --list`: PASS
- `pg_restore --dbname=<scratch> --no-owner --exit-on-error`: PASS (exit 0)
- Schema after restore: `schema_migrations`, `submission_inbox` present; the nine
  `submission_inbox` columns present in declaration order
- Row counts: restored <N> vs source <M> (difference <D>, explained by <reason>)
- `schema_migrations`: exact match
- Cleanup: scratch database dropped, PG17 cluster stopped, port 5432 (PG15 /
  `mcl_test`) untouched throughout
- No submission text was read or printed at any point; only counts, ids and schema.
```

**Step 4: Remove every now-obsolete "pending" claim**

Find and correct each statement that says the real `mcl` drill has not run:

```bash
grep -n "pending first drill\|not met\|does not exist on the VPS yet\|has NOT been done" docs/ops/MCL-48-backup-restore.md
```

Rewrite each hit to reflect reality. In particular §"Status" item 3 ("Jira MCL-48's backup criterion is NOT met by this document") must become an accurate statement that the criterion **is** met, naming the drill date. Do not delete the surrounding honesty about what is still uncovered — only the claims the drill falsified.

**Step 5: Record the pull script's real existence**

§1 currently says "Not yet installed — this is the artefact to create." Correct it: the script now exists at `~/bin/mcl-backup.sh`, mode `0700`, and has produced a verified dump. State plainly whether the LaunchAgent in §2 was installed — if it was not, say so; an unscheduled script is a manual backup, and claiming a schedule that does not fire would be worse than having none.

**Step 6: Add the retention policy status**

If the runbook's `KEEP_DAYS=90` prune has not been ratified as *the* retention policy by a human, add:

```markdown
> **ASSUMPTION / POLICY_NEEDED** — long-term backup retention is not decided. The script
> prunes at 90 days because that is what the script says, not because anyone chose it.
> One laptop-local copy, no encrypted off-machine copy, no legal/consent retention basis
> recorded for family data. This needs its own decision and its own ticket.
```

**Step 7: Verify the mutation reached disk**

```bash
grep -c "pending first drill" docs/ops/MCL-48-backup-restore.md
git diff --stat
```

Expected: `0` for the first command; `docs/ops/MCL-48-backup-restore.md` the **only** changed file in the diff stat.

**Step 8: Commit**

```bash
git add docs/ops/MCL-48-backup-restore.md
git commit -m "docs(MCL-48): record first real off-VPS restore drill

Replaces the pending row in the drill record with the first real drill against
the production mcl database: custom-format dump pulled to this Mac, restored
into a scratch database on the local PostgreSQL 17 cluster with
--exit-on-error, schema and row counts verified, scratch database dropped and
the cluster stopped afterwards. No submission content was read or recorded.

Also corrects the sections that claimed the drill and the pull script were
still pending, and marks long-term retention as an open policy decision."
```

### Task 7: Run the required gates

`AGENTS.md` requires the checks "available for the changed scope". This change is documentation-only, but run the full suite anyway: it is the only way to state the branch is green rather than assume it.

**Step 1: Environment**

```bash
source ~/.nvm/nvm.sh && nvm use 24.18.1
export AVALORIA_FAMILY_ACCESS_CODE="<value from .env.example convention or local .env>"
export AVALORIA_SESSION_SECRET="<local test value>"
```

`check:client-secrets` refuses to run without `AVALORIA_FAMILY_ACCESS_CODE` and a completed build, so it cannot report a vacuous pass. Never print these values.

**Step 2: Run each gate and record its result individually**

```bash
npm run check:foundation
npm run check:secrets
npm run lint
npm run typecheck
npm run test
npm run build
npm run check:client-secrets
```

**Step 3: E2E preconditions, then E2E**

```bash
lsof -ti :3000 || echo "port 3000 free"
rm -rf .data/inbox
export E2E_PORT=3100
npm run test:e2e
```

A foreign server on :3000 and a leftover `.data/inbox` both fake a code regression. Clear them first.

**Step 4: Record the result of every gate**

For each: `PASS`, `FAIL`, or `not_run: <precise reason>`. Never convert an unexecuted check into a pass.

**No commit** (unless a gate exposes a real defect, in which case fix it in a minimal, separate commit on this branch and re-run).

### Task 8: PR, CI, merge

**Step 1: Push**

```bash
git push -u origin docs/MCL-48-first-real-restore-drill
```

**Step 2: Open the PR**

```bash
gh pr create \
  --base main \
  --title "MCL-48: record first real off-VPS restore drill" \
  --body "$(cat <<'EOF'
Closes the last open MCL-48 acceptance criterion: "Backup- und Restore-Pfad ist
dokumentiert und mindestens einmal testweise validiert; Backup muss außerhalb des
einzelnen VPS wiederherstellbar sein."

Documentation only. No application code changed.

The drill, run 2026-08-14 following docs/ops/MCL-48-backup-restore.md §3:
custom-format pg_dump of the production `mcl` database pulled over ssh to a
machine that is not the VPS, `pg_restore --list` verified, restored into a
scratch database on a local PostgreSQL 17 cluster with `--exit-on-error`,
schema and row counts compared against source, scratch database dropped and the
cluster stopped. No submission content was read, printed or stored anywhere in
this repository.

Also corrects the sections that still described the drill and the pull script as
pending, and flags long-term backup retention as an undecided policy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 3: Wait for CI with the shared helper, not an ad-hoc poll loop**

```bash
~/.claude/scripts/gh-ci-wait DYAI2025/MC_legends "$(git rev-parse HEAD)" 900
echo "gh-ci-wait exit: $?"
```

Exit 0 = all runs success, 1 = failure, 2 = timeout/none. Record the exit code.

**Step 4: Inspect the diff before merging**

```bash
gh pr diff --name-only
```

Expected: exactly `docs/ops/MCL-48-backup-restore.md`. Anything else → stop and investigate; the scope was supposed to be documentation only.

**Step 5: Merge only if allowed**

Merge only when CI is green, the diff is as expected, and the user has authorized the merge. Do not bypass branch protection, do not weaken a gate. Record the merge SHA.

---

## Phase 6 — Reconcile MCL-48

### Task 9: Transition Jira only when every precondition holds

**Step 1: Check the gate**

All seven must be true:

```
real production mcl dump created
backup exists outside the VPS
local PG17 restore succeeds
verification passes
scratch data cleaned up
runbook records the real drill
repository evidence is merged
```

Any one false → MCL-48 stays `In Arbeit`. Stop here and report.

**Step 2: Re-read MCL-48 before writing to it**

```
getJiraIssue cloudId=4504291c-8bc0-48f8-ab9e-9ad5d376ca04 issueIdOrKey=MCL-48
```

If the acceptance criteria changed since this plan was written → **BLOCKER: MCL-48 Jira acceptance criteria changed.** Stop.

**Step 3: Compose the comment, re-read it, then send**

External mutations are visible and versioned. Compose → re-read → send, so no drafting fragment ships.

```
MCL-48 — letztes offenes Akzeptanzkriterium geschlossen.

Backup-/Restore-Pfad dokumentiert und erstmals real validiert (2026-08-14):

- Merge-SHA Implementierung: bf130869ed79b478c48ecdb3c6c01b3a13ff6916 (PR #19)
- Merge-SHA Restore-Evidenz: <merge SHA aus Task 8>
- Dump: pg_dump --format=custom --no-owner der produktiven `mcl`-Datenbank,
  per ssh vom VPS auf einen zweiten Rechner gezogen — Backup liegt damit
  außerhalb des einzelnen VPS. Ergebnis: erfolgreich.
- Restore: pg_restore --exit-on-error in eine frische Scratch-Datenbank auf
  einem lokalen PostgreSQL-17-Cluster. Ergebnis: erfolgreich (Exit 0).
- Verifikation: Schema (submission_inbox, schema_migrations) vollständig,
  schema_migrations exakt identisch, Zeilenzahl Quelle <M> / Restore <N>.
- Cleanup: Scratch-Datenbank gelöscht, temporärer Cluster gestoppt.
- Es wurden keine Einreichungsinhalte gelesen, ausgegeben oder gespeichert.

Offen und bewusst nicht Teil von MCL-48: Point-in-Time-Recovery, Alerting,
verschlüsselte Zweitkopie, langfristige Aufbewahrungsrichtlinie.
```

Then:

```
transitionJiraIssue → "Fertig"
```

If Atlassian tooling is unavailable at execution time, **do not pretend**: put the exact comment text and the intended transition in the final report instead.

### Task 10: Confluence reconcile

Only after MCL-48 is genuinely `Fertig`, and only if Confluence access exists. Update these pages from "MCL-48 live / restore pending" to "MCL-48 complete / real off-VPS restore verified":

- MCL project portal
- 04 – Web Architecture and Submission Data Flow
- 07 – Security, Privacy and Submission Integrity
- 09 – Jira Backlog and Traceability Index
- 10 – Delivery Roadmap: Sprint 1–5
- 12 – GitHub Delivery State and Handoff
- 13 – Living World Platform Architecture and AI Governance

Change only the MCL-48 status statements. Do not rewrite unrelated architectural material. Compose → re-read → send for each page.

---

## Phase 7 — MCL-50: protected family/admin inbox read

**Only start this after MCL-48 is `Fertig`.** WIP limit is 1.

### Design decision that must be made before Task 12

`guardFamilyRequest` (`src/adapters/http/family-request-guard.ts`) is documented in-source as the primitive MCL-50 should reuse. But the family access code is the code **children** use to submit. Reusing that one session for the admin read means any child holding the family code can read every other child's submissions.

Jira MCL-50 says "geschützter **Admin-/Familien**zugang" and puts "finale Produktions-Rollen-/Consent-Policy" explicitly **out of scope** — so it does not decide this.

**Narrowest reversible implementation (recommended):** reuse the *mechanism* (`HmacFamilyAccessGate`, `guardFamilyRequest`, the cookie shape) but bind it to a **separate secret and a separate cookie name**:

- `AVALORIA_ADMIN_ACCESS_CODE` — distinct from `AVALORIA_FAMILY_ACCESS_CODE`
- cookie `avaloria_admin_session` — distinct from the family session cookie
- unset or blank code → gate answers `unavailable` → route returns 503, never open access (same fail-closed rule as MCL-34)

This costs one env var and one cookie name, does not touch the child write path, and can be collapsed into a single role later if a real role model is chosen. It avoids the failure mode the handoff names explicitly: misusing the child write-session as an admin role to dodge designing a boundary.

**Mark in the PR and in Jira:** the production role/consent model is unresolved; this is an MVP boundary, not a role system.

Confirm this decision with the user before writing code. If they choose plain family-session reuse instead, that is their call — implement it and record the sibling-visibility consequence in the PR body.

### Task 11: Branch

```bash
git checkout main && git pull
git checkout -b feat/MCL-50-protected-inbox-read
```

### Task 12: The read port

**Files:**
- Create: `src/application/submissions/submission-inbox-reader.ts`
- Test: `tests/unit/submission-inbox-reader-contract.ts`

**Step 1: Write the failing contract test**

Create `tests/unit/submission-inbox-reader-contract.ts` mirroring the shape of the existing `tests/unit/submission-inbox-store-contract.ts` — a `describeSubmissionInboxReaderContract(name, createReader)` exported for both adapters. First case:

```typescript
it("lists stored entries newest-first", async () => {
  const reader = await createReader([
    inboxRecord({ submissionId: "sub-old", receiptId: "r-old", receivedAt: "2026-08-13T09:00:00.000Z" }),
    inboxRecord({ submissionId: "sub-new", receiptId: "r-new", receivedAt: "2026-08-13T10:00:00.000Z" }),
  ]);

  const page = await reader.list({});

  expect(page.entries.map((entry) => entry.submissionId)).toEqual(["sub-new", "sub-old"]);
});
```

**Step 2: Run it and watch it fail**

```bash
npx vitest run tests/unit/submission-inbox-reader-contract.ts
```

Expected: FAIL — the module does not exist. A test that has never been watched failing is not a guard.

**Step 3: Write the port**

`src/application/submissions/submission-inbox-reader.ts`. Deliberately a **separate read type** from `InboxRecord`: `InboxRecord` is the write shape the route mints, and the read side carries `status` and `insertedAt`, which the writer never supplies.

```typescript
/** Processing state as the durable store records it. Widened by a migration, never by a writer. */
export type InboxEntryStatus = "RECEIVED";

/**
 * One inbox entry as the protected read side sees it.
 *
 * `originalText` is the unchanged original artifact. Derived artifacts (transcripts,
 * normalisations, LLM output) are NOT part of this type and must not be folded into it:
 * AGENTS.md requires original and derived to stay separate representations, and a single
 * field carrying either would erase that distinction at the boundary where it matters.
 */
export type InboxEntry = Readonly<{
  submissionId: string;
  kind: "text";
  questionId: string;
  createdAt: string;
  receivedAt: string;
  receiptId: string;
  originalText: string;
  status: InboxEntryStatus;
}>;

/** Server-side filters. Absent field = no constraint on that dimension. */
export type InboxQuery = Readonly<{
  status?: InboxEntryStatus;
  kind?: "text";
  questionId?: string;
  limit?: number;
}>;

export type InboxPage = Readonly<{
  entries: readonly InboxEntry[];
  /** Total matching the filter, independent of `limit`. */
  total: number;
}>;

/**
 * Read boundary for the protected inbox (MCL-50).
 *
 * Separate from SubmissionInboxStore rather than a method on it: the write path is
 * reached by children through the family gate, the read path only by the admin gate.
 * Two ports make it impossible for a route to acquire read capability by asking for the
 * writer, and the composition root is the only place that can hand out either.
 */
export interface SubmissionInboxReader {
  list(query: InboxQuery): Promise<InboxPage>;
}
```

**Step 4: Run the test again**

Expected: still FAIL (no adapter yet), but now failing on the missing implementation, not the missing type.

**Step 5: Commit**

```bash
git add src/application/submissions/submission-inbox-reader.ts tests/unit/submission-inbox-reader-contract.ts
git commit -m "feat(MCL-50): add SubmissionInboxReader read port and its contract test"
```

### Task 13: PostgreSQL reader adapter

**Files:**
- Modify: `src/adapters/persistence/postgres-submission-inbox-store.ts`
- Test: `tests/integration/postgres-submission-inbox-store.test.ts`

**Step 1: Add the failing integration case**

Wire `describeSubmissionInboxReaderContract` into the existing integration test file, which already provisions `mcl_test` on the PG15 cluster at 5432.

**Step 2: Watch it fail**

```bash
npx vitest run tests/integration/postgres-submission-inbox-store.test.ts
```

Expected: FAIL — `list` is not a function.

**Step 3: Implement `list` on the existing class**

Have `PostgresSubmissionInboxStore` implement `SubmissionInboxReader` as well. Requirements, each non-negotiable:

- **Parameterised** `$1`/`$2`/… only. Never string-interpolate a filter value.
- `ORDER BY received_at DESC, submission_id DESC` — the tiebreaker matters: `received_at` is not unique, and without it two entries in the same millisecond can swap order between pages.
- The `submission_inbox_received_at_idx` and `submission_inbox_question_recent_idx` indexes already exist from migration `0001` and were created for exactly this query — do not add new ones.
- `total` from a `count(*)` under the same `WHERE`, so a `limit` cannot make the UI understate how much exists.
- `limit` clamped server-side to a sane maximum (e.g. 200). A client-supplied unbounded limit is a memory question, not a preference.
- Map `created_at` / `received_at` back to ISO strings via `toISOString()`; the pool already pins `DateStyle = 'ISO, YMD'`, which is what keeps pg's timestamptz parser returning a `Date` rather than `null`.

**Step 4: Run the integration test**

```bash
npx vitest run tests/integration/postgres-submission-inbox-store.test.ts
```

Expected: PASS.

**Step 5: Commit**

### Task 14: File reader adapter (rollback path parity)

**Files:**
- Modify: `src/adapters/persistence/file-submission-inbox-store.ts`
- Test: `tests/unit/file-submission-inbox-store.test.ts`

The file store is MCL-48's documented rollback path and must stay reachable. If it cannot serve the read side, falling back silently breaks the admin view.

The JSONL lines carry no `status` field. Default to `"RECEIVED"` on read, and say so in a comment: it is the same default the schema applies, so the two adapters agree.

Same TDD cycle: failing test → watch it fail → implement → PASS → commit.

### Task 15: Admin access gate

**Files:**
- Modify: `src/composition/server.ts`
- Create: `src/adapters/http/admin-request-guard.ts` (or a parameterised extension of `family-request-guard.ts` — prefer the latter if it stays readable)
- Test: `tests/unit/admin-request-guard.test.ts`

**Required cases, each watched failing first:**

1. No cookie → `unauthorized`
2. Family session cookie presented to the admin guard → `unauthorized` *(this is the case that proves the boundary is real, not decorative)*
3. Valid admin session → `granted`
4. Unset/blank `AVALORIA_ADMIN_ACCESS_CODE` → `unavailable` (fail closed, never open)
5. Over the rate limit → `rate-limited`

**Architecture constraint:** `tests/architecture/boundaries.test.ts` asserts that only `src/composition/server.ts` may name `AVALORIA_FAMILY_ACCESS_CODE` and `AVALORIA_SESSION_SECRET`. Extend that assertion to cover `AVALORIA_ADMIN_ACCESS_CODE` in the same excluded-file style, and **watch the extended assertion fail** by temporarily naming the variable in another file. An architecture test that has never failed is a vacuous one.

### Task 16: The protected GET route

**Files:**
- Create: `src/app/api/admin/inbox/submissions/route.ts`
- Test: `tests/unit/admin-inbox-route.test.ts`

Model it on `src/app/api/inbox/submissions/route.ts`.

**Required behaviour:**
- Gate decision **first, from headers alone**, before any query parsing. An unauthorised caller costs this server a cookie parse.
- Status codes: `401` unauthorized, `429` too-many-requests, `503` inbox-unavailable, `400` invalid-query.
- Errors are machine-readable codes only — never an exception message, path, or stack trace.
- Filters read from the query string: `status`, `kind`, `questionId`, `limit`. Reject unknown values rather than ignoring them.
- **No mutation verbs.** No `POST`, `PATCH`, `PUT`, `DELETE` on this route. Add a test asserting a `POST` to it is rejected — "no change to the original via the UI" must be enforced by the absence of a handler, and pinned by a test so a later edit cannot reintroduce one silently.

### Task 17: The admin UI

**Files:**
- Create: `src/app/admin/inbox/page.tsx` (server component)
- Create: `src/app/admin/inbox/inbox-filters.tsx` (client component, filters only)

**Constraints:**
- The page is a **server component**; it calls the reader through the composition root. React never touches PostgreSQL and never sees a connection string.
- The filter component is the only client code, and it holds no data — it manipulates the query string.
- Show per entry: `submissionId`, question reference, kind, timestamps, processing status, receipt id + receivedAt (ACK traceability), and the original text in a **visually distinct, read-only** region.
- Render an explicit "keine abgeleiteten Artefakte" area — the separation between original and derived must be visible even while no derived artifacts exist yet.
- No form, no editable control, no action button anywhere near the original text.
- **Do not touch the public child UI.** The Avaloria World → Workshop redesign is out of scope for MCL-50; MCL-47 is its bridge.

### Task 18: E2E and the gates

**Files:**
- Create: `tests/e2e/admin-inbox.spec.ts`

**Required E2E cases:**
1. Anonymous `GET /admin/inbox` → not served (no child data on the wire)
2. Anonymous `GET /api/admin/inbox/submissions` → 401
3. Child family session → still 401 on the admin route
4. Admin session → the inbox renders and filters work

Use `tests/support/` helpers for session construction; never inline a real secret.

**Never put real child text in a fixture.** `tests/support/child-safe.ts` exists for this; use it.

Then run the full gate suite from Task 7, plus:

```bash
npm run test:architecture
```

Record each result as `PASS` / `FAIL` / `not_run: <reason>`.

### Task 19: PR

Open a PR referencing MCL-50. In the body, state explicitly:

- the auth model chosen and that the **production role/consent model remains unresolved** (Jira puts it out of scope)
- that no derived artifacts exist yet and how the UI represents that
- that the child UI is unchanged

Then CI via `~/.claude/scripts/gh-ci-wait`, diff inspection, and merge only with authorization.

---

## Risks and unresolved decisions

1. **The `mcl` database may not exist on the VPS.** The runbook says it did not when written. Task 1 Step 2 is the gate; if it fails, the whole plan stops at Phase 1 and MCL-48 stays `In Arbeit`.
2. **The pull script has never existed.** The runbook describes an artifact, not a fact. Task 3 creates it; until then there is no backup of anything.
3. **Backup retention is undecided.** `KEEP_DAYS=90` is a value in a script, not a policy. Flagged as `ASSUMPTION / POLICY_NEEDED`.
4. **One laptop-local copy only.** A lost or stolen MacBook loses the backups. No encrypted off-machine copy exists.
5. **No PITR, no alerting.** Worst-case loss is everything since the last successful pull, and on a laptop that is not bounded by 24 hours.
6. **The VPS has no backup of anything else.** `gbrain`, the `AVALORIA_*` secrets, every other service. MCL-48 fixes one slice. Out of scope here, but it does not stop being true.
7. **MCL-50 auth semantics are a product decision, not a technical one.** See the design decision block before Task 12. Must be confirmed with the user before code.
8. **`status` has exactly one value today** (`'RECEIVED'`, CHECK-constrained). The status filter is therefore real but currently trivial. Widening it is a migration, not a code change — correct, and worth saying in the PR so nobody reads a one-value dropdown as a bug.

## Definition of done

```
MCL-48 real off-VPS restore drill PASS
→ runbook evidence merged
→ MCL-48 Jira = Fertig
→ Confluence reconciled
→ MCL-50 started on a fresh dedicated branch
```

Acceptable partial outcome: the drill identifies a real defect → defect documented → MCL-48 stays `In Arbeit` → MCL-50 not started.

Truth over sequence completion.
