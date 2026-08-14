# Deploying MC Legends with PostgreSQL persistence on `srv1308064.hstgr.cloud`

MCL-48. This is the runbook for putting the family submission inbox on a durable
PostgreSQL database instead of an append-only JSONL file, on the VPS that already serves
the app.

Read it start to finish before running anything. Provisioning creates a role and a
database on a host that also runs unrelated services (`gbrain`, `openwa-postgres`,
`whatsapp-brain`, `lpam-frontend-1`, `qdrant`), so every step below is deliberately
**additive** and none of them touches those.

Every command in this document is run **on the VPS as root over ssh** unless it says
otherwise.

---

## 1. Observed baseline

All of this was verified read-only on **2026-08-13**. It is the state this runbook was
written against; if something no longer matches, stop and re-check before continuing.

| Area | Observed |
|---|---|
| OS / arch | Ubuntu 25.10, x86_64 |
| Disk `/` | 96 G total, **75 G used, 22 G free (78 %)** |
| PostgreSQL | **17.10**, `postgresql@17-main.service`, `ssl` on |
| Config paths | `/etc/postgresql/17/main/postgresql.conf`, `/etc/postgresql/17/main/pg_hba.conf`, data `/var/lib/postgresql/17/main` |
| `listen_addresses` | `localhost`, `port` 5432 |
| Listening sockets | **`127.0.0.1:5432` and `[::1]:5432` only** |
| Databases | `gbrain` (44 MB, owner `gbrain`), `postgres`, `template0`, `template1` — **no MCL database** |
| Login roles | `gbrain`, `postgres`, both superusers — **no MCL role** |
| Extensions available | `pgcrypto`, `uuid-ossp`, `pg_stat_statements` |
| Firewall | ufw active, default **deny incoming**, **deny routed**. Allowed inbound: 22, 80, 443, **8443**. 5432 allowed from nowhere. |
| App | Docker container `mc-legends`, image `mc-legends:0bcec9b1`, `restart=unless-stopped`, published `127.0.0.1:3010->3000`, bind `/opt/mc-legends/data:/data` |
| Build inputs | `/opt/mc-legends/Dockerfile` over `/opt/mc-legends/src-checkout`, whose HEAD is canonical main `0bcec9b10d14d143fcd1f8cda815fed654093234` |
| Deploy automation | **None.** No systemd unit, no compose file, no deploy script. The container was started by hand. |
| Container env keys | `AVALORIA_FAMILY_ACCESS_CODE`, `AVALORIA_SESSION_SECRET`, `AVALORIA_INBOX_DIR`, `NODE_ENV`, `PORT`, `HOSTNAME`. Values live in `/opt/mc-legends/app.env`, mode `0600`, root-owned. |
| nginx | `sites-available/mc-legends`: `listen 8443 ssl`, `server_name srv1308064.hstgr.cloud`, Let's Encrypt cert, `proxy_pass http://127.0.0.1:3010`. Second vhost `mclegends.dyai.cloud` on 80 to the same upstream. |
| Existing data | `/opt/mc-legends/data/inbox/submissions.jsonl` — **1 line, 286 bytes**. Directory mode `0700 root:root`. |

### The finding that shapes everything below

The container sits on the default Docker bridge at `172.17.0.3` with gateway
`172.17.0.1`. **A TCP connect from inside the container to `172.17.0.1:5432` times out.**

That is not a misconfiguration to fix — it is the firewall and `listen_addresses`
working as intended. But it means the app **cannot reach PostgreSQL over TCP at all
today**, and any `DATABASE_URL` of the form `postgresql://…@localhost:5432/…` or
`…@172.17.0.1:5432/…` will fail at runtime while every local test passes. Local tests
run against a database on the same host as the test process; the container does not.

---

## 2. Why a Unix socket, not a TCP port

The app connects through `/var/run/postgresql`, bind-mounted into the container. Nothing
else changes: `listen_addresses` stays `localhost`, ufw stays as it is, no port is
published, no new rule is added.

The reason is not convenience. Jira MCL-48 requires that the database port is not
publicly exposed to the browser app. A socket makes that true **by construction**: there
is no additional listening address to expose and no firewall rule whose absence has to be
remembered. The alternatives all make it true only by ongoing discipline:

- Binding PostgreSQL to `172.17.0.1` would expose 5432 to **every** container on
  `docker0`, including `whatsapp-brain` and `openwa-postgres` — services that have
  nothing to do with this project.
- Publishing a host port and allowing it in ufw makes the guarantee a configuration
  someone can undo later without noticing.
- A second, containerised PostgreSQL would add another engine to patch, monitor and back
  up, for one small table.

The socket costs exactly one additive `pg_hba.conf` line and one `-v` flag.

---

## 3. One-time provisioning

**Human-triggered.** Run this yourself; do not delegate it to an agent. It creates a role
and a database on a shared host.

Everything here is additive. Nothing is dropped, altered or renamed, and the `gbrain`
database is never opened.

### 3.1 Create the role, with the password typed and never echoed

```bash
sudo -u postgres psql
```

At the `psql` prompt, use `\prompt` so the value never appears on the shell command line,
in `~/.bash_history`, in `~/.psql_history` or in the PostgreSQL log:

```sql
\set HISTFILE /dev/null
\prompt 'password for mcl_app: ' mcl_pw
CREATE ROLE mcl_app WITH LOGIN PASSWORD :'mcl_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE mcl OWNER mcl_app;
\unset mcl_pw
```

Notes:

- `\prompt` reads from the terminal, not from the command line, so the value is never an
  argument to any process and never lands in a history file. `\set HISTFILE /dev/null`
  keeps the `CREATE ROLE` line itself — which contains the value after `psql` substitutes
  `:'mcl_pw'` — out of `~/.psql_history`.
- `NOSUPERUSER NOCREATEDB NOCREATEROLE` is the point of having a separate role at all.
  The app can read and write its own database and nothing else. Do **not** reuse `gbrain`
  or `postgres`; both are superusers.
- The database is owned by `mcl_app`, so the migration runner can create tables in it
  without any further grant.

Write the password into your password manager now. You will need it once more, in §5.

Verify (no password is printed):

```sql
\du mcl_app
\l mcl
```

Expect a role `mcl_app` with no attributes listed, and a database `mcl` owned by
`mcl_app`. Then `\q`.

### 3.2 Add exactly one `pg_hba.conf` line — position matters

The observed file has these lines, **in this order**:

```
local   all   postgres                    peer
local   all   all                         peer
host    all   all   127.0.0.1/32          scram-sha-256
host    all   all   ::1/128               scram-sha-256
(then the three replication equivalents)
```

`pg_hba.conf` is evaluated top to bottom and the **first matching line wins**. A socket
connection from the container matches `local all all … peer` — and peer authentication
compares the connecting OS user to the database role, which for the container's user will
never be `mcl_app`. The connection is then **refused outright**; there is no fallthrough
to a later line.

So the new line must go **before** the `local all all … peer` catch-all:

```bash
cp /etc/postgresql/17/main/pg_hba.conf /etc/postgresql/17/main/pg_hba.conf.pre-mcl48
${EDITOR:-nano} /etc/postgresql/17/main/pg_hba.conf
```

Result — one added line, scoped to one database and one role:

```
local   all   postgres                    peer
local   mcl   mcl_app                     scram-sha-256    # MCL-48
local   all   all                         peer
host    all   all   127.0.0.1/32          scram-sha-256
host    all   all   ::1/128               scram-sha-256
```

Then reload — **reload, not restart**; other services use this server:

```bash
systemctl reload postgresql@17-main
```

Confirm the file was accepted and the rule is live:

```bash
sudo -u postgres psql -Atc \
  "select type, database, user_name, auth_method, line_number from pg_hba_file_rules order by line_number;"
```

Expect the `mcl` / `mcl_app` / `scram-sha-256` row to appear **above** the `all` / `all` /
`peer` row, and no row with a non-empty `error` column.

---

## 4. Prove the exposure did not change

Run this immediately after §3, before anything else. It is the check that the socket
decision actually held.

```bash
ss -tlnp | grep 5432
ufw status | grep 5432
```

Expected:

- `ss` prints **exactly two lines**, `127.0.0.1:5432` and `[::1]:5432`. Any other address
  — `0.0.0.0`, `172.17.0.1`, the public IP — means `listen_addresses` was changed and the
  MCL-48 exposure criterion is broken. Stop and revert.
- `ufw status | grep 5432` prints **nothing**. Any output means a firewall rule for the
  database port now exists. Stop and revert.

---

## 5. Configure the app

The connection string has **no host and no port** — the `host=` parameter names a
directory, which is how libpq is told to use a Unix socket:

```
postgresql://mcl_app:<password>@/mcl?host=/var/run/postgresql
```

Append it to the existing secrets file, which stays `0600` and root-owned:

```bash
umask 077
${EDITOR:-nano} /opt/mc-legends/app.env
```

Add one line (substitute the real password from §3.1; if it contains `@ / : ? # %` or
another URL-reserved character, percent-encode it, or re-set the role's password to one
that does not):

```
DATABASE_URL=postgresql://mcl_app:<password>@/mcl?host=/var/run/postgresql
```

Then:

```bash
chmod 0600 /opt/mc-legends/app.env
ls -l /opt/mc-legends/app.env    # expect -rw------- root root
```

`src/composition/server.ts` reads this variable and nothing else decides the store: set
and non-blank selects `PostgresSubmissionInboxStore`; unset or blank selects the file
store. That is deliberate, and it is the rollback path in §9.

---

## 6. Build the new image and run the migrations

### 6.1 Update the checkout and build

```bash
cd /opt/mc-legends/src-checkout
git fetch origin
git log --oneline -1                     # record the SHA you are leaving
git checkout <merged-MCL-48-commit-sha>
git log --oneline -1                     # record the SHA you are moving to
docker build -f /opt/mc-legends/Dockerfile -t mc-legends:<short-sha> /opt/mc-legends/src-checkout
```

Tag with the short SHA, matching the existing convention (`mc-legends:0bcec9b1`). Keep
the old image — it is part of the rollback story if the new one turns out not to start at
all.

### 6.2 Apply the migrations — inside the container, not on the host

The schema must exist before anything serves traffic against it. The runner
(`scripts/migrate.mjs`) applies each pending file in `db/migrations/` in filename order,
each in one transaction together with its `schema_migrations` row, under a
`pg_advisory_lock` so two runs cannot race. It refuses to start without `DATABASE_URL`.

**Do not run it from the host checkout.** Measured on the VPS on 2026-08-13:

| Where | Node | npm |
|---|---|---|
| Host PATH | **v22.22.2** | 10.9.7 |
| Inside container `mc-legends` | **v24.19.0** | — |

`package.json` pins `"engines": { "node": ">=24.18.1 <25", "npm": ">=11.16.0 <12" }`. The
host's v22.22.2 fails that check, so `npm ci` in `/opt/mc-legends/src-checkout` refuses to
run. The container's v24.19.0 satisfies it. Everything below therefore goes through
`docker exec`.

This has an **ordering consequence, and it is deliberate**: the container must be rebuilt
and started (§8) **before** the migrations can be applied. For that window the app is up
against a database whose `submission_inbox` table does not exist yet. That is safe and it
is not silent: the store throws, `POST /api/inbox/submissions` answers
**`503 inbox-unavailable`**, and no submission is accepted-then-lost. Keep the window
short, and do not run §9.2 until this section is done.

So: build (§6.1) → start the container (§8) → return here.

#### Verify the rebuilt image before migrating

The **currently running** image (`mc-legends:0bcec9b1`) predates this branch: it has
neither `/app/db/migrations` nor `/app/node_modules/pg`, because neither existed at the
commit it was built from. Both appear only after the rebuild. Check that the rebuild
actually produced them, rather than discovering it from a migration failure:

```bash
docker exec mc-legends sh -lc 'ls -d /app/db/migrations /app/node_modules/pg && node -v'
```

Expect both paths listed and `v24.19.0` (or any `24.18.1 <= v < 25`). If either path is
missing, the image is not the one you think it is — re-check §6.1 before going further.

Why this works, verified on 2026-08-13:

- The image is built by `COPY src-checkout/ ./`, and there is **no `.dockerignore` in the
  build context** (`ls: cannot access '/opt/mc-legends/.dockerignore': No such file or
  directory`). Nothing is filtered out, so `db/migrations/` and `scripts/` are copied in.
  `/app/scripts` already exists in the running image, which is the same mechanism observed
  working.
- `npm ci` in the Dockerfile installs `pg` as soon as `package.json` carries it — which is
  what this branch adds.
- `DATABASE_URL` reaches the container through `--env-file /opt/mc-legends/app.env` (§8),
  so it is already in the container's environment. Nothing has to be exported by hand.

#### Run it

```bash
docker exec mc-legends npm run db:migrate
```

Expected on a fresh database:

```
applied 0001_submission_inbox
applied 1 migration(s)
```

Run it a **second** time. It must print:

```
no pending migrations
```

That is the idempotency check, and it is worth the ten seconds: it proves the runner
recorded what it applied, so a later deploy that re-runs it changes nothing.

Confirm the table exists and is empty:

```bash
sudo -u postgres psql -d mcl -Atc "select count(*) from submission_inbox;"      # expect 0
sudo -u postgres psql -d mcl -Atc "select version from schema_migrations;"      # expect 0001_submission_inbox
```

---

## 7. Import the existing JSONL

There is exactly **one** line (286 bytes) in `/opt/mc-legends/data/inbox/submissions.jsonl`
— one real answer from a real person. It has to arrive in the new store.

Run this through `docker exec` for the same reason as §6.2 — the importer needs
`node_modules/pg`, and installing that on the host means `npm ci` under the host's Node
v22.22.2, which the `engines` pin refuses. Inside the container the driver is already
installed and `DATABASE_URL` is already in the environment.

The JSONL is visible to the container at `/data/inbox/submissions.jsonl`, because §8
bind-mounts `/opt/mc-legends/data` to `/data`. Confirm that before importing:

```bash
docker exec mc-legends sh -lc 'wc -c /data/inbox/submissions.jsonl'   # expect 286
```

```bash
docker exec mc-legends node scripts/import-inbox-jsonl.mjs /data/inbox/submissions.jsonl
```

Expected:

```
imported 1, already present 0, of 1 record(s) in /data/inbox/submissions.jsonl
```

Properties this relies on, all exercised against a real database before shipping:

- **Idempotent.** Inserts use `ON CONFLICT (submission_id) DO NOTHING`. Running it twice
  imports nothing the second time and overwrites nothing — the second run prints
  `imported 0, already present 1, of 1`. If you are unsure whether the import already
  ran, just run it again.
- **Read-only on the source.** The JSONL is never moved, truncated or rewritten. It is
  the rollback artefact; deleting it would make the rollback in §9 lossy.
- **Loud, not lenient.** A line that is not valid JSON, or that is missing a field, aborts
  the whole import naming the line number, and nothing is written. It does not skip the
  line. A silently dropped line here is a child's answer deleted with nobody told, and
  this project does not do that.

Verify the row landed:

```bash
sudo -u postgres psql -d mcl -Atc "select count(*) from submission_inbox;"   # expect 1
```

---

## 8. Start the container

Identical to the observed invocation, **plus one `-v`**:

```bash
docker stop mc-legends && docker rm mc-legends

docker run -d \
  --name mc-legends \
  --restart unless-stopped \
  --env-file /opt/mc-legends/app.env \
  -p 127.0.0.1:3010:3000 \
  -v /opt/mc-legends/data:/data \
  -v /var/run/postgresql:/var/run/postgresql \
  mc-legends:<short-sha>
```

Unchanged and deliberately so: the published address stays `127.0.0.1:3010`, so nginx
remains the only way in; the `/opt/mc-legends/data` bind mount stays, because that is
where the rollback artefact lives.

**Run this before §6.2 and §7.** The migrations and the JSONL import both go through
`docker exec` into this container, so this section comes first and the app serves for a
short window against a database with no `submission_inbox` table — see §6.2 for why that
is safe.

### Socket permissions — checked, nothing to change

Observed on the VPS on 2026-08-13:

```
drwxrwsr-x  2 postgres postgres  /var/run/postgresql
srwxrwxrwx  1 postgres postgres  /var/run/postgresql/.s.PGSQL.5432
container:  uid=0(root) gid=0(root),  image Config.User is empty
```

The directory is `r-x` for others, so anything can traverse into it; the socket itself is
`srwxrwxrwx`, so anything can connect; and the container runs as **root** because the
image sets no `USER`. The bind mount works as written — no `chmod`, no `usermod`, no
supplementary group.

Worth noting for later, because it is the part that could change without anyone thinking
about this file: even a **non-root** container user would still connect, given those two
modes. Re-check only if `/var/run/postgresql` ever loses its world-execute bit, or if the
socket mode is tightened — an `EACCES` (as opposed to a timeout) is the signature.

---

## 9. Verify the deployed artefact, not the local test run

Green unit tests, a green `npm run check:foundation` and a successful local integration
run prove none of the following: that the assembled image contains the driver, that the
container can see the socket, that the `pg_hba.conf` line is ordered correctly, or that
the password stored in `app.env` is the one the role actually has. Only the deployed
thing proves that.

### 9.1 Both health endpoints

```bash
curl -s https://srv1308064.hstgr.cloud:8443/api/health
curl -s https://srv1308064.hstgr.cloud:8443/api/health/ready
```

Expected:

```json
{"status":"ok"}
{"app":"ok","database":"ok"}
```

What the two mean, and why they are separate:

- `/api/health` answers "is this process serving?" and keeps answering `{"status":"ok"}`
  even with the database down. That is on purpose — if it reported the database too, an
  outage would be indistinguishable from a crashed app.
- `/api/health/ready` reports `app` and `database` separately, opening a **fresh**
  short-lived connection each call rather than asking the pool. It therefore exercises
  the socket, the role and the `pg_hba.conf` line every time. `database: "ok"` → 200;
  `"not-configured"` (no `DATABASE_URL`, i.e. the file store) → 200; `"unavailable"` →
  **503**.

If you get `{"app":"ok","database":"not-configured"}`, the container did not receive
`DATABASE_URL` — check `--env-file` and that the line in `app.env` has no stray quotes.
If you get 503 with `"unavailable"`, read `docker logs mc-legends`: the readiness probe
logs the driver's full error server-side (and deliberately never in the response, because
that response is public and the error names the connection string).

### 9.2 One real submission through the real UI

Open **`https://srv1308064.hstgr.cloud:8443/#frage`** in a browser, sign in with the
family access code, and submit one answer. Do not curl the API for this step — the point
is to exercise the whole path a child actually uses, including the session cookie and the
gate.

Then:

```bash
sudo -u postgres psql -d mcl -Atc "select count(*) from submission_inbox;"
```

Expect **2** (the imported line plus the new one).

### 9.3 Restart, and prove the row is still there

```bash
docker restart mc-legends
sleep 10
curl -s https://srv1308064.hstgr.cloud:8443/api/health/ready
sudo -u postgres psql -d mcl -Atc "select count(*) from submission_inbox;"
```

Expect `{"app":"ok","database":"ok"}` and the **same count as in §9.2**. This is the
acceptance criterion "data survives redeploys and process restarts", checked rather than
assumed.

Record the counts you actually saw. A number you did not read is not evidence.

---

## 10. Rollback

Three steps, no rebuild, no code revert, no schema drop:

```bash
${EDITOR:-nano} /opt/mc-legends/app.env    # delete the DATABASE_URL line
docker restart mc-legends
curl -s https://srv1308064.hstgr.cloud:8443/api/health/ready
```

Expect `{"app":"ok","database":"not-configured"}` — 200, not 503, because the file store
is a legitimate configuration and not a fault.

`createSubmissionInboxStore()` then returns `FileSubmissionInboxStore` again, writing to
the bind-mounted `/opt/mc-legends/data/inbox/submissions.jsonl`, which was never deleted
or modified. The rollback is free precisely because the importer only ever read it.

What rollback does **not** do: rows written to PostgreSQL while it was live stay in
PostgreSQL. They are not copied back to the JSONL. If you roll back after real
submissions have landed in the database, export them before deciding the incident is
closed:

```bash
sudo -u postgres psql -d mcl -Atc \
  "select row_to_json(t) from (select submission_id, kind, question_id, created_at, received_at, receipt_id, original_text from submission_inbox order by received_at) t;"
```

Leave the role, the database, the `pg_hba.conf` line and the socket mount in place. They
cost nothing while unused, and re-adding one line to `app.env` is then the whole way
forward again.

---

## 11. Things that would silently break this

Each of these keeps the app looking healthy while quietly invalidating something MCL-48
promises. They are listed because each was found by review, not by a failing test.

### 11.1 A transaction-mode connection pooler in front of PostgreSQL

**What breaks.** `PostgresSubmissionInboxStore` pins `SET TIME ZONE 'UTC'` and
`SET DateStyle = 'ISO, YMD'` in an awaited `onConnect` hook — once per pooled connection.
A pooler in **transaction mode** (PgBouncer's default, and what most managed "pooled"
connection strings mean) hands each transaction a different server connection. The two
`SET`s then apply to whatever server connection the pooler happened to lend for that
statement, and every later statement runs on a session that was never pinned. Both
settings silently revert to the server defaults, and §11.3 becomes live.

**Check.** There is none today, and there must not be one added without changing the
adapter. Confirm the connection string still points at
`host=/var/run/postgresql` — a socket path cannot have a pooler in front of it. If a
pooler is ever introduced, it must run in **session** mode, or the two `SET`s must move
from `onConnect` into every query path.

### 11.2 `synchronous_commit = off`

**What breaks.** The route answers `201` only after the database reports the insert
committed. With `synchronous_commit = off` PostgreSQL acknowledges a commit **before** the
WAL record reaches disk — so a power loss or an OS crash within the flush window loses
transactions that were already acknowledged. The ACK a child was shown would then be a
promise the system did not keep, which is exactly the failure MCL-48 exists to remove.

**Check.**

```bash
sudo -u postgres psql -d mcl -Atc "show synchronous_commit;"      # expect: on
sudo -u postgres psql -d mcl -Atc "select current_setting('synchronous_commit');"
```

Also check it is not set per-database or per-role, which `show` in a different session
would not reveal:

```bash
sudo -u postgres psql -Atc "select rolname, rolconfig from pg_roles where rolconfig is not null;"
sudo -u postgres psql -Atc "select datname, datconfig from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase;"
```

Neither should mention `synchronous_commit`. Expect `on` in all cases.

### 11.3 A non-ISO `DateStyle`

**What breaks.** Under any output style other than ISO, `pg`'s `timestamptz` parser
returns `null` instead of a `Date`. The adapter now detects that and throws an error
naming the column and the required setting — but note the **shape** of the failure, which
is why this is listed rather than considered closed: the `stored: true` path never reads a
row back, so **first submissions keep succeeding** and only **retries** of an already-
stored submission fail, with a permanent 503. A partial failure that looks like a flaky
network and is not.

It can be introduced from three directions without anyone touching the app:
`ALTER DATABASE mcl SET datestyle = …`, `ALTER ROLE mcl_app SET datestyle = …`, a
`PGDATESTYLE` in the container environment, or an `?options=-c datestyle=…` appended to
the connection string.

**Check.**

```bash
sudo -u postgres psql -d mcl -Atc "show datestyle;"    # expect: ISO, MDY or ISO, DMY - the leading word must be ISO
grep -i datestyle /opt/mc-legends/app.env              # expect: no output
docker exec mc-legends env | grep -i PGDATESTYLE       # expect: no output
```

The two `pg_roles` / `pg_db_role_setting` queries in §11.2 cover the `ALTER … SET` cases;
neither should mention `datestyle` either. The adapter pins the session setting itself, so
a server default other than ISO is survivable — but only as long as §11.1 stays true.

---

## 12. Disk

`/` is 96 G with **22 G free (78 % used)** as observed on 2026-08-13. That is ample for
this table: text rows capped at 4000 characters, a household's worth of answers, plus WAL.

It is **not** ample for what comes next. MCL-49 adds audio artefacts, and unless they are
placed elsewhere they land on this same volume. Revisit capacity — and the backup sizing
in `docs/ops/MCL-48-backup-restore.md` — **before** starting MCL-49, not after the first
upload fails.

```bash
df -h /
```

---

## 13. Open items carried by this runbook

Three TODOs that this document used to carry are **closed**, resolved read-only on the VPS
on 2026-08-13 and folded into the sections themselves:

- Node version on the VPS → §6.2 (host v22.22.2 fails the `engines` pin, container
  v24.19.0 satisfies it; everything runs via `docker exec`).
- Image contents → §6.2 (no `.dockerignore` in the build context, so `db/migrations/` and
  `scripts/` are copied in; `pg` is installed by the Dockerfile's `npm ci` once
  `package.json` carries it — but only in the **rebuilt** image, hence the check there).
- Socket permissions → §8 (`drwxrwsr-x` directory, `srwxrwxrwx` socket, container runs as
  root; nothing to change).

What is still open:

1. **No reproducible deploy** — there is still no systemd unit, compose file or deploy
   script. This document is currently the only record of how the container is started.
   Converting it to a checked-in unit is out of MCL-48's scope and should be its own
   ticket.
2. **Backups** — there is **no working backup of anything on this host**. See
   `docs/ops/MCL-48-backup-restore.md`. MCL-48's backup criterion is not met until a real
   restore drill has been run.
