# MCL-48 PostgreSQL Submission Persistence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist confirmed text submissions durably in PostgreSQL 17 on `srv1308064.hstgr.cloud` behind the existing `SubmissionInboxStore` port, so a positive ACK is only minted after a durable database write.

**Architecture:** A new `PostgresSubmissionInboxStore` adapter implements the existing `SubmissionInboxStore` interface unchanged — the route, the use case and the domain do not move. The app container reaches PostgreSQL over a **bind-mounted Unix domain socket**, so no new TCP surface is created and the DB port stays loopback-only. Schema changes are plain versioned SQL applied by a small idempotent runner. The file store stays in the tree as the rollback path.

**Tech Stack:** Next.js 16 / React 19 / TypeScript 6 / Vitest 4 / Playwright 1.62 / `pg` (node-postgres) / PostgreSQL 17.10 (Ubuntu, host-installed) / Docker (single container, manual `docker run`) / nginx reverse proxy.

---

## Part 0 — Preflight evidence (read-only, already verified 2026-08-13)

This plan was written against observed runtime state, not assumptions. Everything below was verified read-only; **no writes, no installs, no migrations, no secret values were read or disclosed.**

### 0.1 Repository

| Fact | Evidence |
|---|---|
| Canonical repo | `DYAI2025/MC_legends` (`origin` in this checkout) |
| Canonical `main` SHA | `0bcec9b10d14d143fcd1f8cda815fed654093234` — **matches the verified input; main has not moved** |
| Local checkout HEAD | `29565996fd05db81fd1c0a7a5a581b9208d2669b` — **stale**, 1 commit named `first commit`; do not branch from it, branch from `origin/main` |
| MCL-48 branch | none — remote heads are `main`, `agent/mcl-23-…`, `agent/mcl-sprint-1-web`, `feat/MCL-34-secure-family-inbox`, `fix/ci-e2e-delivery-baseline`, `sprint-2/web-family-mvp` |
| MCL-48 PR | none — 14 PRs total, none mentions MCL-48 |
| `pg` dependency | absent from `package.json` on `origin/main` |
| **Conclusion** | **MCL-48 is not being implemented anywhere. No stop condition triggered.** |

### 0.2 Existing persistence on `origin/main`

- Port: `src/application/submissions/submission-inbox-store.ts` — `appendIfAbsent(record): Promise<AppendOutcome>`. Its own doc comment already names MCL-48 and states the Postgres adapter is expected to enforce idempotency **with a unique constraint on submissionId**. This plan follows that.
- Adapter in use: `src/adapters/persistence/file-submission-inbox-store.ts` (append-only JSONL).
- Wiring: `src/composition/server.ts` → `createSubmissionInboxStore()`, default dir `.data/inbox`, overridable by `AVALORIA_INBOX_DIR`.
- Writer: `src/app/api/inbox/submissions/route.ts` — mints `receiptId`/`receivedAt`, calls `appendIfAbsent`, answers `201` on store, `200` on idempotent retry with the **existing** record's receipt, `503 inbox-unavailable` on a throw.
- Health: `src/app/api/health/route.ts` returns `{"status":"ok"}` and touches nothing. **App and DB are not separately checkable today.**

### 0.3 VPS `srv1308064.hstgr.cloud` — sanitized observations

| Area | Observed |
|---|---|
| OS / arch | Ubuntu 25.10, x86_64, up 20 days |
| Resources | 7.9 GB RAM (4.3 GB available), `/` 96 G — **75 G used, 22 G free, 78 %** |
| PostgreSQL | **17.10 installed and running** (`postgresql@17-main.service` active), `/usr/bin/psql`, `/usr/bin/pg_dump` present |
| `listen_addresses` | `localhost` · `port` 5432 · `ssl` on |
| Actual sockets | `127.0.0.1:5432` and `[::1]:5432` only |
| `pg_hba.conf` | `local … peer`; `host all all 127.0.0.1/32 scram-sha-256`; `host all all ::1/128 scram-sha-256`; replication likewise. **No non-loopback host rule.** |
| Databases | `gbrain` (44 MB, owner `gbrain`), `postgres`, `template0`, `template1`. **No MCL database exists.** |
| Login roles | `gbrain` (superuser), `postgres` (superuser). Nothing else. **No MCL role exists.** No password/hash was read. |
| Extensions available | `pgcrypto`, `uuid-ossp`, `pg_stat_statements` |
| Firewall | ufw active, default deny incoming / **deny routed**. Allowed: 22, 80, 443, **8443**. Many explicit denies. 5432 is not allowed from anywhere. |
| MCL deployment | Docker container `mc-legends`, image `mc-legends:0bcec9b1`, `restart=unless-stopped`, created 2026-08-13T09:13Z, published `127.0.0.1:3010->3000`, bind `/opt/mc-legends/data:/data`. **No systemd unit, no compose file, no deploy script found** — built from `/opt/mc-legends/Dockerfile` over `/opt/mc-legends/src-checkout`. |
| Deployed source | `/opt/mc-legends/src-checkout` HEAD = `0bcec9b10d…` — **the running container is canonical main** |
| Container env keys | `AVALORIA_FAMILY_ACCESS_CODE`, `AVALORIA_SESSION_SECRET`, `AVALORIA_INBOX_DIR`, `NODE_ENV`, `PORT`, `HOSTNAME` (keys only — **no values read**). Secrets live in `/opt/mc-legends/app.env`, mode `0600`. |
| nginx | `sites-available/mc-legends` → `listen 8443 ssl`, `server_name srv1308064.hstgr.cloud`, Let's Encrypt cert, `proxy_pass http://127.0.0.1:3010`. Second vhost `mclegends.dyai.cloud` on port 80 → same upstream. |
| Live check | `GET https://srv1308064.hstgr.cloud:8443/api/health` → **200** `{"status":"ok"}` |
| Persistent data location | `/opt/mc-legends/data/inbox/submissions.jsonl` — **1 line, 286 bytes**. Dir mode `0700 root:root`. |
| Unrelated services (do not touch) | `openwa-postgres` (pgvector pg16, no host port published), `whatsapp-brain` (**restart-looping**), `lpam-frontend-1`, `qdrant`, plus host DB `gbrain` |

### 0.4 PostgreSQL exposure verdict

**NOT PUBLICLY EXPOSED — and no change in this plan alters that.**

Three independent layers agree: `listen_addresses = localhost`; the only listening sockets are `127.0.0.1:5432` / `[::1]:5432`; ufw allows only 22/80/443/8443 inbound and defaults routed traffic to deny. `pg_hba.conf` has no non-loopback `host` rule.

**Consequence — and the single most important technical finding of this preflight:** the `mc-legends` container **cannot currently reach PostgreSQL at all.** It sits on `docker0` at `172.17.0.3` with gateway `172.17.0.1`; a TCP connect from inside the container to `172.17.0.1:5432` **timed out**. Any MCL-48 implementation that assumes `DATABASE_URL=postgres://…@localhost:5432/…` will fail at runtime while every local test passes. This plan closes that gap with a Unix socket bind-mount (decision recorded in §0.7).

### 0.5 Backup / restore readiness verdict

**MISSING — this is the widest gap between MCL-48's acceptance criteria and reality.**

- `restic`, `borg`, `rclone`, `pgbackrest`, `wal-g`, `duplicity`, `autopostgresqlbackup`: **all absent.**
- `rclone listremotes`: not configured/absent → **no external target is configured on this host.**
- Root crontab contains `0 3 * * * /opt/openfang/scripts/backup.sh` — **that script does not exist** (`sed: can't read … No such file or directory`). The only backup-looking cron entry on the box is dead.
- Only backup-ish timer: `dpkg-db-backup.timer` (package metadata, irrelevant).
- `/var/backups` holds nothing but dpkg/apt rotation artefacts.

There is **no working backup of anything on this VPS today**, and no path off the host.

### 0.6 MCL-48 acceptance-criterion readiness matrix

| # | Acceptance criterion (Jira MCL-48) | Today | Closed by |
|---|---|---|---|
| 1 | Records persisted with stable id, questionId, createdAt, receivedAt, kind, status, unchanged original text | ⚠️ Partial — JSONL holds all but `status` | Task 3 (schema), Task 5 (adapter) |
| 2 | Re-delivery of the same submissionId creates no uncontrolled duplicates | ⚠️ Partial — file adapter scans what it wrote; not crash-safe, not concurrent-safe | Task 5 (`PRIMARY KEY` + `ON CONFLICT DO NOTHING`) |
| 3 | Data survives frontend/backend redeploys and process restarts | ⚠️ Partial — survives via bind mount, but is a flat file on one disk | Tasks 3–6 |
| 4 | Positive ACK only after successful durable PostgreSQL write | ❌ ACK follows a file append | Task 5 + Task 6 |
| 5 | DB port not publicly exposed to the browser app | ✅ **Already true** — loopback-only + ufw | Task 7 preserves it (socket, no new port) |
| 6 | Migrations/schema versioned and reproducible | ❌ No migration mechanism at all | Tasks 2–3 |
| 7 | Backup/restore documented **and validated at least once**, restorable off this VPS | ❌ **Nothing exists** (§0.5) | Task 8 — **needs the open decision below** |
| 8 | Adapter tests and integration/failure tests present | ❌ No DB tests exist | Tasks 4, 5, 6 |
| 9 | Health/readiness can check app and PostgreSQL **separately** | ❌ `/api/health` is a constant | Task 6 |

Out of scope per Jira and honoured here: audio blobs (MCL-49), LLM/gbrain evaluation, final production account/consent policy.

### 0.7 Decisions recorded

- **DB connectivity — DECIDED by user: Unix domain socket bind-mount.** `/var/run/postgresql` is mounted into the container; the app connects over the socket. Zero new TCP surface, so AC 5 holds by construction rather than by configuration discipline. Requires exactly one additive `pg_hba.conf` line for the MCL role. Rejected alternatives: binding PostgreSQL to `172.17.0.1` would expose 5432 to *every* container on `docker0` including `whatsapp-brain` and `openwa-postgres`; a separate containerised Postgres would add a second engine to patch and back up.
- **Backup target — OPEN.** The question was asked and not answered with a target. Task 8 is written against the recommended default: **pull-based `pg_dump` from the Berlin Linux box over Tailscale** (`dyai@100.103.64.33`), because it needs no package install on the VPS, no storage credential *on* the VPS, and no inbound port — a compromised VPS cannot reach or delete the copies. **Confirm or override this before starting Task 8;** Tasks 1–7 are unaffected either way.

### 0.8 Files and services likely to change

**Repository (new):** `src/adapters/persistence/postgres-submission-inbox-store.ts`, `src/app/api/health/ready/route.ts`, `db/migrations/0001_submission_inbox.sql`, `scripts/migrate.mjs`, `scripts/import-inbox-jsonl.mjs`, `docs/deploy/vps-mc-legends.md`, `docs/ops/MCL-48-backup-restore.md`, `tests/unit/submission-inbox-store-contract.ts`, `tests/integration/postgres-submission-inbox-store.test.ts`, `tests/unit/health-ready-route.test.ts`.

**Repository (modified):** `package.json` (add `pg`, `@types/pg`, `db:migrate` script), `src/composition/server.ts` (store selection + `DATABASE_URL`), `scripts/check-foundation.mjs` (new required paths), `tests/unit/file-submission-inbox-store.test.ts` (adopt shared contract), `AGENTS.md` / `CLAUDE.md` (commands), `.github/workflows/*` (migrate + integration job).

**VPS (changed at deploy time, all additive):** new role `mcl_app` and database `mcl`; one `pg_hba.conf` line before the `local all all peer` catch-all; `/opt/mc-legends/app.env` gains `DATABASE_URL`; the `docker run` invocation gains `-v /var/run/postgresql:/var/run/postgresql`. **Unchanged:** `listen_addresses`, ufw, nginx, ports, and every unrelated service including `gbrain`.

### 0.9 Migration and rollback boundaries

- **Forward:** `0001_submission_inbox.sql` creates a new database and table only. It touches no existing object; the `gbrain` database is never opened.
- **Data:** exactly **one** JSONL line (286 bytes) needs importing. `scripts/import-inbox-jsonl.mjs` is idempotent (`ON CONFLICT DO NOTHING`) and never deletes the file.
- **Rollback:** unset `DATABASE_URL` in `app.env` and restart the container → `createSubmissionInboxStore()` returns the file store again and the bind-mounted JSONL is still there. **No code revert, no DB drop, no redeploy of a different image is required.** Rows written to Postgres in the meantime stay in Postgres.
- **Irreversible steps:** none in Tasks 1–8. Creating a role and a database is additive; dropping them is a separate deliberate act.

### 0.10 Blockers and unknowns

1. **Backup target unconfirmed** (§0.7) — blocks only Task 8, i.e. only AC 7.
2. **Disk at 78 %** (22 G free). Fine for text rows; revisit before MCL-49 puts audio on the same volume.
3. **`whatsapp-brain` is restart-looping** — pre-existing, unrelated, explicitly untouched. Noise in `docker ps`, not a blocker.
4. **No systemd unit for `mc-legends`** — the container is `restart=unless-stopped`, so it survives reboots, but there is no reproducible deploy script in the repo. Task 7 writes the run command down; converting to systemd/compose is deliberately **not** in this plan's scope.
5. **`gbrain` MCP returned zero results** for the MCL-48 project query — the project-context hook's knowledge base has no MCL entries. Jira + Confluence were used as the authority instead.
6. **Node version pin** — `package.json` requires `>=24.18.1 <25`; the host has `v22.22.2` on PATH but the container image is `node:24-bookworm-slim`. Run repo commands locally under nvm `v24.18.1`.

**VERDICT: `READY_FOR_MCL_48_PLAN`** — VPS access is unambiguous, no secret disclosure was needed, no write was required to complete the preflight, canonical main has not moved, and no MCL-48 implementation exists elsewhere. The one open item (backup target) is scoped to Task 8 and does not block Tasks 1–7.

---

## Part 1 — Implementation tasks

**Before Task 1:** branch from canonical main, not from this stale checkout.

```bash
git fetch origin main
git switch -c feat/MCL-48-postgres-submission-persistence origin/main
nvm use 24.18.1 && node -v   # expect v24.18.1
npm ci
```

---

### Task 1: Add the PostgreSQL driver

**Files:**
- Modify: `package.json`

**Step 1: Install the driver**

```bash
npm install pg@8.16.3
npm install --save-dev @types/pg@8.15.6
```

**Step 2: Add the migration script entry**

In `package.json`, inside `"scripts"`, after `"check:foundation"`:

```json
    "db:migrate": "node scripts/migrate.mjs",
```

**Step 3: Verify the tree still builds**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(MCL-48): add pg driver and db:migrate script"
```

---

### Task 2: Versioned migration runner

The runner is deliberately ~60 lines of plain SQL application rather than an ORM: AC 6 asks for versioned and reproducible, not for a schema DSL, and every extra abstraction here is one more thing to back up and restore.

**Files:**
- Create: `scripts/migrate.mjs`
- Create: `db/migrations/.gitkeep`

**Step 1: Write the runner**

```javascript
// scripts/migrate.mjs
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = "db/migrations";

/**
 * Applies every not-yet-applied migration in filename order, each in its own
 * transaction together with the row that records it. A crash between the DDL and the
 * bookkeeping would otherwise leave a schema no later run can reason about.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (cause) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${version} failed: ${cause.message}`);
      }
      console.log(`applied ${version}`);
      count += 1;
    }

    console.log(count === 0 ? "no pending migrations" : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

await main();
```

**Step 2: Verify it refuses to run without a target**

Run: `node scripts/migrate.mjs; echo "exit=$?"`
Expected: `DATABASE_URL is not set` and `exit=1`. Watch it fail — a migration runner that silently no-ops is worse than none.

**Step 3: Commit**

```bash
git add scripts/migrate.mjs db/migrations/.gitkeep
git commit -m "feat(MCL-48): add versioned SQL migration runner"
```

---

### Task 3: Submission inbox schema

**Files:**
- Create: `db/migrations/0001_submission_inbox.sql`

**Step 1: Write the migration**

```sql
-- 0001_submission_inbox.sql
-- Durable store for confirmed family submissions (MCL-48).
-- submission_id is the PRIMARY KEY, not a surrogate: idempotent re-delivery is a
-- property the port promises, and the database is the only place that can hold it
-- across concurrent requests and process crashes alike.

CREATE TABLE submission_inbox (
  submission_id text        PRIMARY KEY,
  kind          text        NOT NULL,
  question_id   text        NOT NULL,
  created_at    timestamptz NOT NULL,
  received_at   timestamptz NOT NULL,
  receipt_id    text        NOT NULL,
  -- Unchanged original text exactly as submitted. Never trimmed, never normalised.
  original_text text        NOT NULL,
  status        text        NOT NULL DEFAULT 'RECEIVED',
  inserted_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT submission_inbox_kind_known CHECK (kind IN ('text')),
  CONSTRAINT submission_inbox_status_known CHECK (status IN ('RECEIVED'))
);

-- MCL-50 lists the inbox newest-first and filters by question.
CREATE INDEX submission_inbox_received_at_idx ON submission_inbox (received_at DESC);
CREATE INDEX submission_inbox_question_id_idx ON submission_inbox (question_id);
```

`kind` and `status` are CHECK-constrained to today's only legal values on purpose: MCL-30 adding `'audio'` and MCL-50 adding review states must each be a visible migration, not a value that quietly appears in the table.

**Step 2: Commit**

```bash
git add db/migrations/0001_submission_inbox.sql
git commit -m "feat(MCL-48): add submission_inbox schema migration"
```

---

### Task 4: Shared store contract test

Both adapters must satisfy one contract. Writing it once is what makes "the route does not change when the store does" checkable instead of merely stated.

**Files:**
- Create: `tests/unit/submission-inbox-store-contract.ts`
- Modify: `tests/unit/file-submission-inbox-store.test.ts`

**Step 1: Write the contract suite**

```typescript
// tests/unit/submission-inbox-store-contract.ts
import { describe, expect, it } from "vitest";
import type {
  InboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

export function inboxRecord(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    kind: "text",
    submissionId: "sub-1",
    questionId: "q-1",
    createdAt: "2026-08-13T09:00:00.000Z",
    receivedAt: "2026-08-13T09:00:01.000Z",
    receiptId: "receipt-1",
    originalText: "  ein drache mit  zwei koepfen  ",
    ...overrides,
  };
}

/**
 * The behaviour every SubmissionInboxStore must have, run against each adapter.
 * `createStore` must hand back an empty store each call.
 */
export function describeSubmissionInboxStoreContract(
  name: string,
  createStore: () => Promise<SubmissionInboxStore>,
): void {
  describe(`${name} (SubmissionInboxStore contract)`, () => {
    it("stores a record it has not seen", async () => {
      const store = await createStore();
      await expect(store.appendIfAbsent(inboxRecord())).resolves.toEqual({ stored: true });
    });

    it("returns the kept record for a repeated submissionId instead of storing again", async () => {
      const store = await createStore();
      const first = inboxRecord();
      await store.appendIfAbsent(first);

      const retry = inboxRecord({ receiptId: "receipt-2", receivedAt: "2026-08-13T10:00:00.000Z" });
      const outcome = await store.appendIfAbsent(retry);

      expect(outcome.stored).toBe(false);
      // The receipt the submission already has - byte for byte. A second receipt for
      // one submissionId is the exact failure this contract exists to prevent.
      expect(outcome.stored === false && outcome.existing.receiptId).toBe("receipt-1");
      expect(outcome.stored === false && outcome.existing.receivedAt).toBe(
        "2026-08-13T09:00:01.000Z",
      );
    });

    it("keeps the original text unchanged, including surrounding whitespace", async () => {
      const store = await createStore();
      const record = inboxRecord({ submissionId: "sub-ws" });
      await store.appendIfAbsent(record);

      const outcome = await store.appendIfAbsent(inboxRecord({ submissionId: "sub-ws" }));
      expect(outcome.stored === false && outcome.existing.originalText).toBe(
        "  ein drache mit  zwei koepfen  ",
      );
    });

    it("keeps distinct submissionIds apart", async () => {
      const store = await createStore();
      await store.appendIfAbsent(inboxRecord({ submissionId: "sub-a" }));
      await expect(
        store.appendIfAbsent(inboxRecord({ submissionId: "sub-b" })),
      ).resolves.toEqual({ stored: true });
    });
  });
}
```

**Step 2: Point the existing file-store test at the contract**

Append to `tests/unit/file-submission-inbox-store.test.ts` (keep every existing case — they cover file-specific behaviour the contract does not):

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSubmissionInboxStore } from "@/adapters/persistence/file-submission-inbox-store";
import { describeSubmissionInboxStoreContract } from "./submission-inbox-store-contract";

describeSubmissionInboxStoreContract("FileSubmissionInboxStore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcl-inbox-"));
  return new FileSubmissionInboxStore(directory);
});
```

**Step 3: Run the file-store tests**

Run: `npx vitest run tests/unit/file-submission-inbox-store.test.ts`
Expected: PASS, including the four new contract cases. If any contract case fails, the *contract* is wrong — fix it here before writing the Postgres adapter against it.

**Step 4: Commit**

```bash
git add tests/unit/submission-inbox-store-contract.ts tests/unit/file-submission-inbox-store.test.ts
git commit -m "test(MCL-48): extract shared SubmissionInboxStore contract"
```

---

### Task 5: PostgreSQL adapter

**Files:**
- Create: `src/adapters/persistence/postgres-submission-inbox-store.ts`
- Create: `tests/integration/postgres-submission-inbox-store.test.ts`

**Step 1: Write the failing integration test**

```typescript
// tests/integration/postgres-submission-inbox-store.test.ts
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresSubmissionInboxStore } from "@/adapters/persistence/postgres-submission-inbox-store";
import {
  describeSubmissionInboxStoreContract,
  inboxRecord,
} from "../unit/submission-inbox-store-contract";

const connectionString = process.env.MCL_TEST_DATABASE_URL;

/**
 * Skipped without a real database rather than mocked against one. A mocked pool would
 * prove the adapter calls pg, not that ON CONFLICT actually holds - which is the only
 * thing this adapter is here for. CI sets MCL_TEST_DATABASE_URL (Task 9).
 */
const suite = connectionString ? describe : describe.skip;

if (connectionString) {
  const admin = new pg.Pool({ connectionString });
  let counter = 0;

  afterAll(async () => {
    await admin.end();
  });

  describeSubmissionInboxStoreContract("PostgresSubmissionInboxStore", async () => {
    counter += 1;
    await admin.query("DELETE FROM submission_inbox");
    return new PostgresSubmissionInboxStore(connectionString);
  });

  suite("PostgresSubmissionInboxStore (database specifics)", () => {
    it("rejects a concurrent duplicate without minting a second receipt", async () => {
      await admin.query("DELETE FROM submission_inbox");
      const store = new PostgresSubmissionInboxStore(connectionString);

      const outcomes = await Promise.all([
        store.appendIfAbsent(inboxRecord({ submissionId: "race", receiptId: "r-a" })),
        store.appendIfAbsent(inboxRecord({ submissionId: "race", receiptId: "r-b" })),
      ]);

      expect(outcomes.filter((o) => o.stored)).toHaveLength(1);
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM submission_inbox WHERE submission_id = $1",
        ["race"],
      );
      expect(rows[0].n).toBe(1);
    });

    it("fails loudly when the database is unreachable", async () => {
      const broken = new PostgresSubmissionInboxStore(
        "postgresql://nobody@127.0.0.1:1/nothing?connect_timeout=1",
      );
      await expect(broken.appendIfAbsent(inboxRecord())).rejects.toThrow();
    });
  });
}
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/integration/postgres-submission-inbox-store.test.ts`
Expected: FAIL — cannot resolve `@/adapters/persistence/postgres-submission-inbox-store`.

**Step 3: Write the adapter**

```typescript
// src/adapters/persistence/postgres-submission-inbox-store.ts
import pg from "pg";
import type {
  AppendOutcome,
  InboxRecord,
  SubmissionInboxStore,
} from "@/application/submissions/submission-inbox-store";

/**
 * One pool per connection string for the lifetime of the process.
 *
 * src/composition/server.ts builds a store per request, which is right for a file
 * that holds no connection and wrong for a database: a pool per request would open
 * and abandon connections until PostgreSQL refuses new ones. Ownership therefore sits
 * here, exactly as the composition root's own comment requires.
 */
const pools = new Map<string, pg.Pool>();

function poolFor(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Without this an idle client dropped by the server takes the process with it.
    pool.on("error", (cause) => console.error("postgres pool error", cause));
    pools.set(connectionString, pool);
  }
  return pool;
}

type Row = Readonly<{
  submission_id: string;
  kind: string;
  question_id: string;
  created_at: Date;
  received_at: Date;
  receipt_id: string;
  original_text: string;
}>;

/**
 * Timestamps come back as Date and are re-rendered as ISO-8601 UTC. `receivedAt` is
 * minted by the route with `toISOString()`, so it round-trips byte-identically - which
 * is what lets an idempotent retry answer with the very receipt the first call gave.
 * A client-supplied `createdAt` carrying an offset is normalised to UTC: the same
 * instant, a different string. It is never echoed in an ACK, so nothing observes the
 * difference; the contract test pins both halves of this.
 */
function toRecord(row: Row): InboxRecord {
  return {
    kind: "text",
    submissionId: row.submission_id,
    questionId: row.question_id,
    createdAt: row.created_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    receiptId: row.receipt_id,
    originalText: row.original_text,
  };
}

export class PostgresSubmissionInboxStore implements SubmissionInboxStore {
  readonly #pool: pg.Pool;

  constructor(connectionString: string) {
    this.#pool = poolFor(connectionString);
  }

  async appendIfAbsent(record: InboxRecord): Promise<AppendOutcome> {
    const inserted = await this.#pool.query<Row>(
      `INSERT INTO submission_inbox
         (submission_id, kind, question_id, created_at, received_at, receipt_id, original_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (submission_id) DO NOTHING
       RETURNING submission_id, kind, question_id, created_at, received_at, receipt_id, original_text`,
      [
        record.submissionId,
        record.kind,
        record.questionId,
        record.createdAt,
        record.receivedAt,
        record.receiptId,
        record.originalText,
      ],
    );

    if (inserted.rowCount === 1) {
      // The row is committed before this returns, so the 201 the route sends is a
      // statement about durable storage and not about intent.
      return { stored: true };
    }

    const existing = await this.#pool.query<Row>(
      `SELECT submission_id, kind, question_id, created_at, received_at, receipt_id, original_text
         FROM submission_inbox
        WHERE submission_id = $1`,
      [record.submissionId],
    );

    const row = existing.rows[0];
    if (!row) {
      // Insert refused and the row is gone: something deleted it between the two
      // statements. Throwing is the honest answer - the route turns it into a 503 and
      // the child is invited to retry, which is recoverable. Claiming a receipt we do
      // not hold would not be.
      throw new Error(`submission ${record.submissionId} vanished between insert and read`);
    }

    return { stored: false, existing: toRecord(row) };
  }
}
```

**Step 4: Run the tests with a real database**

```bash
export MCL_TEST_DATABASE_URL="postgresql://postgres@localhost:5432/mcl_test"
psql "$MCL_TEST_DATABASE_URL" -c 'select 1' >/dev/null   # create the db first if needed
DATABASE_URL="$MCL_TEST_DATABASE_URL" npm run db:migrate
npx vitest run tests/integration/postgres-submission-inbox-store.test.ts
```

Expected: PASS — four contract cases plus the two database-specific cases.

**Step 5: Commit**

```bash
git add src/adapters/persistence/postgres-submission-inbox-store.ts tests/integration/postgres-submission-inbox-store.test.ts
git commit -m "feat(MCL-48): add PostgreSQL submission inbox adapter"
```

---

### Task 6: Wire the store and split health from readiness

**Files:**
- Modify: `src/composition/server.ts`
- Create: `src/app/api/health/ready/route.ts`
- Create: `tests/unit/health-ready-route.test.ts`
- Modify: `scripts/check-foundation.mjs`

**Step 1: Write the failing readiness test**

```typescript
// tests/unit/health-ready-route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("GET /api/health/ready", () => {
  it("reports the application healthy and the database unavailable when it cannot be reached", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://nobody@127.0.0.1:1/nothing?connect_timeout=1");
    const { GET } = await import("@/app/api/health/ready/route");

    const response = await GET();
    expect(response.status).toBe(503);
    // App and database are answered separately: an app that is up with a database
    // that is not must be distinguishable from a process that is simply down.
    await expect(response.json()).resolves.toEqual({ app: "ok", database: "unavailable" });
  });

  it("never leaks the connection string or a driver message", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://secret-user:hunter2@127.0.0.1:1/x?connect_timeout=1");
    const { GET } = await import("@/app/api/health/ready/route");

    const body = await (await GET()).text();
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("secret-user");
    expect(body).not.toContain("127.0.0.1");
  });

  it("reports the database as not configured rather than failing when DATABASE_URL is unset", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { GET } = await import("@/app/api/health/ready/route");

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ app: "ok", database: "not-configured" });
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/health-ready-route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/health/ready/route`.

**Step 3: Extend the composition root**

In `src/composition/server.ts`, add the import and replace `createSubmissionInboxStore`:

```typescript
import { PostgresSubmissionInboxStore } from "@/adapters/persistence/postgres-submission-inbox-store";
```

```typescript
/**
 * Reading DATABASE_URL here and nowhere else keeps the architecture rule intact: this
 * module stays the only place in src that names an environment variable, and the
 * Postgres adapter takes its connection string as an argument like the file adapter
 * takes its directory.
 *
 * Absent or blank DATABASE_URL falls back to the file store on purpose - that is the
 * rollback path of MCL-48. Removing one line from app.env and restarting is enough;
 * no redeploy, no revert.
 */
export function databaseUrl(): string | null {
  return process.env.DATABASE_URL?.trim() || null;
}

export function createSubmissionInboxStore(): SubmissionInboxStore {
  const url = databaseUrl();
  if (url) {
    return new PostgresSubmissionInboxStore(url);
  }

  return new FileSubmissionInboxStore(
    process.env.AVALORIA_INBOX_DIR?.trim() || DEFAULT_INBOX_DIRECTORY,
  );
}
```

**Step 4: Write the readiness route**

```typescript
// src/app/api/health/ready/route.ts
import pg from "pg";
import { databaseUrl } from "@/composition/server";

type DatabaseState = "ok" | "unavailable" | "not-configured";

/**
 * Readiness, deliberately separate from /api/health.
 *
 * /api/health answers "is this process serving?" and must keep answering that even
 * when the database is down - otherwise a DB outage looks identical to a crashed app
 * and the operator learns nothing. This route answers the second question, and MCL-48
 * requires both to be checkable apart.
 *
 * A short-lived client rather than the adapter's pool: readiness must probe the real
 * connection path now, not report that a pooled connection was healthy some time ago.
 */
async function probeDatabase(connectionString: string): Promise<DatabaseState> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return "ok";
  } catch (cause) {
    // Logged server-side only. The response body stays a fixed vocabulary: a driver
    // message would put the connection string, and with it a password, on a public URL.
    console.error("readiness probe failed", cause);
    return "unavailable";
  } finally {
    await client.end().catch(() => {});
  }
}

export async function GET(): Promise<Response> {
  const url = databaseUrl();
  const database: DatabaseState = url === null ? "not-configured" : await probeDatabase(url);

  return Response.json(
    { app: "ok", database },
    { status: database === "unavailable" ? 503 : 200 },
  );
}
```

**Step 5: Run the readiness tests**

Run: `npx vitest run tests/unit/health-ready-route.test.ts`
Expected: PASS, all three cases.

**Step 6: Register the new files with the foundation check**

In `scripts/check-foundation.mjs`, add to the `required` array:

```javascript
  "src/adapters/persistence/postgres-submission-inbox-store.ts",
  "src/app/api/health/ready/route.ts",
  "db/migrations/0001_submission_inbox.sql",
  "scripts/migrate.mjs",
  "docs/deploy/vps-mc-legends.md",
  "docs/ops/MCL-48-backup-restore.md",
```

**Step 7: Run the full local gate**

Run: `npm run check:foundation && npm run lint && npm run typecheck && npm run test`
Expected: `check:foundation` FAILS first with `ENOENT` on `docs/deploy/vps-mc-legends.md` — those two docs land in Tasks 7 and 8. Either write them now or reorder; do not delete the entries to make the gate green.

**Step 8: Commit**

```bash
git add src/composition/server.ts src/app/api/health/ready/route.ts tests/unit/health-ready-route.test.ts scripts/check-foundation.mjs
git commit -m "feat(MCL-48): select the Postgres store and split readiness from health"
```

---

### Task 7: VPS provisioning and deploy documentation

No command in this task is run by the plan — this task **writes them down**. Provisioning happens under Benjamin's hand, on his say-so, because it creates a role and a database on a shared host.

**Files:**
- Create: `docs/deploy/vps-mc-legends.md`

**Step 1: Write the document**

````markdown
# MCL deploy on srv1308064.hstgr.cloud

## Observed baseline (2026-08-13)

Container `mc-legends`, image `mc-legends:<short-sha>`, `restart=unless-stopped`,
published `127.0.0.1:3010->3000`, bind `/opt/mc-legends/data:/data`, secrets in
`/opt/mc-legends/app.env` (mode 0600). nginx `sites-available/mc-legends` terminates
TLS on 8443 and proxies to `127.0.0.1:3010`. There is no systemd unit and no compose
file; the container is built and started by hand from `/opt/mc-legends/Dockerfile`
over `/opt/mc-legends/src-checkout`.

PostgreSQL 17.10 runs on the host with `listen_addresses = localhost`. It is reachable
on `127.0.0.1:5432` and `[::1]:5432` only, and ufw allows 22/80/443/8443 inbound with
routed traffic denied by default. **A container on docker0 cannot reach it over TCP** —
verified: a connect from inside `mc-legends` to `172.17.0.1:5432` times out.

## Why a Unix socket

Connecting over `/var/run/postgresql` keeps that true. Nothing binds a new address,
nothing opens a firewall rule, and the "DB port is not publicly exposed" criterion holds
by construction rather than by remembering not to change `listen_addresses` later.

## One-time provisioning

Additive only. Nothing below alters `listen_addresses`, ufw, nginx, or any other
service on the host — in particular the `gbrain` database and role are never touched.

```bash
# 1. Role and database. Choose the password out of band; do not paste it into a shell
#    that writes history, and never into the repository.
sudo -u postgres createuser --no-createdb --no-createrole --no-superuser mcl_app
sudo -u postgres psql -c "\password mcl_app"     # interactive, value never echoed
sudo -u postgres createdb --owner=mcl_app mcl

# 2. One additive pg_hba line, placed BEFORE the `local all all peer` catch-all,
#    otherwise peer wins and the container is refused.
#    Insert into /etc/postgresql/17/main/pg_hba.conf:
#       local   mcl     mcl_app                                 scram-sha-256
sudo systemctl reload postgresql@17-main

# 3. Confirm nothing about the exposure changed.
sudo ss -tlnp | grep 5432      # expect ONLY 127.0.0.1:5432 and [::1]:5432
sudo ufw status | grep 5432    # expect no output
```

## Connection string

```
DATABASE_URL=postgresql://mcl_app:<password>@/mcl?host=/var/run/postgresql
```

Appended to `/opt/mc-legends/app.env` (mode 0600, root-owned). No host, no port, no
TCP. The password never leaves that file and is never read by any repository command.

## Migrating

Run from a checkout on the host, before starting the new container:

```bash
cd /opt/mc-legends/src-checkout
set -a; . /opt/mc-legends/app.env; set +a
npm run db:migrate      # expect "applied 0001_submission_inbox" then "applied 1 migration(s)"
```

Re-running is safe: the second run prints `no pending migrations`.

## Importing the existing JSONL line

```bash
set -a; . /opt/mc-legends/app.env; set +a
node scripts/import-inbox-jsonl.mjs /opt/mc-legends/data/inbox/submissions.jsonl
```

Idempotent, and it never deletes or rewrites the file — the JSONL stays as the
rollback artefact.

## Running the container

```bash
docker rm -f mc-legends
docker build -t "mc-legends:$(git -C /opt/mc-legends/src-checkout rev-parse --short HEAD)" \
  -f /opt/mc-legends/Dockerfile /opt/mc-legends
docker run -d --name mc-legends --restart unless-stopped \
  --env-file /opt/mc-legends/app.env \
  -v /opt/mc-legends/data:/data \
  -v /var/run/postgresql:/var/run/postgresql \
  -p 127.0.0.1:3010:3000 \
  "mc-legends:$(git -C /opt/mc-legends/src-checkout rev-parse --short HEAD)"
```

The socket mount is the only change from the previously observed invocation.

## Verifying the deployed artefact

Green tests on a laptop do not prove the assembled container talks to the real
database with the real injected secret. Check the deployment itself:

```bash
curl -sk https://srv1308064.hstgr.cloud:8443/api/health         # {"status":"ok"}
curl -sk https://srv1308064.hstgr.cloud:8443/api/health/ready   # {"app":"ok","database":"ok"}
```

Then submit one answer through the real UI at
`https://srv1308064.hstgr.cloud:8443/#frage`, restart the container, and confirm the
row is still counted:

```bash
docker restart mc-legends
sudo -u postgres psql -d mcl -tAc 'select count(*) from submission_inbox'
```

## Rollback

Remove the `DATABASE_URL` line from `/opt/mc-legends/app.env` and
`docker restart mc-legends`. The app falls back to the bind-mounted JSONL, which was
never deleted. No image rebuild, no code revert, no schema drop.
````

**Step 2: Commit**

```bash
git add docs/deploy/vps-mc-legends.md
git commit -m "docs(MCL-48): document VPS provisioning, socket wiring and rollback"
```

---

### Task 8: Backup and validated restore

**Confirm the external target before starting this task** (§0.7). Written below against the recommended pull-from-Berlin default.

**Files:**
- Create: `docs/ops/MCL-48-backup-restore.md`
- Create: `scripts/import-inbox-jsonl.mjs`

**Step 1: Write the JSONL importer**

```javascript
// scripts/import-inbox-jsonl.mjs
import { readFile } from "node:fs/promises";
import pg from "pg";

const [, , path] = process.argv;
if (!path) {
  console.error("usage: node scripts/import-inbox-jsonl.mjs <submissions.jsonl>");
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString?.trim()) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

let imported = 0;
let skipped = 0;

try {
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const record = JSON.parse(line);
    // ON CONFLICT DO NOTHING, so re-running the import cannot duplicate or overwrite.
    const result = await client.query(
      `INSERT INTO submission_inbox
         (submission_id, kind, question_id, created_at, received_at, receipt_id, original_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (submission_id) DO NOTHING`,
      [
        record.submissionId,
        record.kind,
        record.questionId,
        record.createdAt,
        record.receivedAt,
        record.receiptId,
        record.originalText,
      ],
    );
    result.rowCount === 1 ? (imported += 1) : (skipped += 1);
  }
} finally {
  await client.end();
}

console.log(`imported ${imported}, already present ${skipped}, of ${imported + skipped}`);
```

**Step 2: Write the backup/restore runbook**

````markdown
# MCL-48 backup and restore

## Starting point (2026-08-13)

There is **no backup of anything on this VPS**. `restic`, `borg`, `rclone`,
`pgbackrest`, `wal-g` and `duplicity` are all absent; `rclone` has no remotes; the only
backup-looking cron entry (`0 3 * * * /opt/openfang/scripts/backup.sh`) points at a
script that **does not exist**. `/var/backups` holds dpkg rotation artefacts only.

## Shape: pull, not push

The Berlin machine pulls; the VPS stores no backup credential and opens no inbound
port. A compromised VPS therefore cannot reach, corrupt or delete the copies — which is
most of what "restorable outside the single VPS" is for.

## On Berlin (`dyai@100.103.64.33`, over Tailscale)

`/home/dyai/backups/mcl/pull-mcl-db.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

DEST="/home/dyai/backups/mcl"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"

# Custom format: pg_restore can then rebuild selectively and verify without replaying.
ssh -i ~/.ssh/id_ed25519 root@srv1308064.hstgr.cloud \
  "sudo -u postgres pg_dump --format=custom --no-owner --dbname=mcl" \
  > "$DEST/mcl-$STAMP.dump"

# A dump that cannot be listed is not a backup. Fail now, not during an incident.
pg_restore --list "$DEST/mcl-$STAMP.dump" > /dev/null

find "$DEST" -name 'mcl-*.dump' -mtime +30 -delete
echo "ok $STAMP $(stat -c%s "$DEST/mcl-$STAMP.dump") bytes"
```

Scheduled by a systemd timer on Berlin, daily. Only the dump crosses the wire; no
secret is copied in either direction.

## Restore drill — run once, and record the result here

AC 7 asks for a restore that was **actually performed**, not one that is documented.
Restore to a scratch database on Berlin, never over `mcl`:

```bash
createdb mcl_restore_test
pg_restore --no-owner --dbname=mcl_restore_test /home/dyai/backups/mcl/mcl-<STAMP>.dump
psql -d mcl_restore_test -tAc 'select count(*) from submission_inbox'
psql -d mcl_restore_test -tAc 'select version from schema_migrations order by 1'
dropdb mcl_restore_test
```

Both counts must match the source. Record date, dump size, row count and who ran it in
the table below, and paste the same numbers into MCL-48.

| Date | Dump | Rows restored | Migrations | By |
|---|---|---|---|---|
| _pending first drill_ | | | | |

## What this does not cover

Point-in-time recovery (no WAL archiving), the `AVALORIA_*` secrets in `app.env`, and
the audio artefacts MCL-49 will add. Each is a separate decision, not an oversight.
````

**Step 3: Commit**

```bash
git add docs/ops/MCL-48-backup-restore.md scripts/import-inbox-jsonl.mjs
git commit -m "docs(MCL-48): add pull-based backup runbook and JSONL importer"
```

---

### Task 9: CI coverage for the database path

**Files:**
- Modify: `.github/workflows/ci.yml` (confirm the real filename first — `ls .github/workflows/`)

**Step 1: Add a PostgreSQL service and migration step**

```yaml
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: mcl_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
```

```yaml
      - name: Migrate test database
        run: npm run db:migrate
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mcl_test

      - name: Test
        run: npm run test
        env:
          MCL_TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mcl_test
```

**Step 2: Prove the integration suite is not silently skipping**

Run locally without the variable: `npx vitest run tests/integration/ 2>&1 | grep -i skip`
Expected: the suite reports as skipped. Then confirm CI logs show it **running** — a
guarded suite that never runs anywhere is the vacuous-test failure mode this repo has
already been bitten by once.

**Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci(MCL-48): run adapter integration tests against PostgreSQL 17"
```

---

### Task 10: Full verification and PR

**Step 1: Run the repository gate**

Run: `npm run verify`
Expected: `check:foundation`, `check:secrets`, `lint`, `typecheck`, `test`, `build` all pass.

**Step 2: Run E2E against a Postgres-backed instance**

```bash
export E2E_PORT=3100
export DATABASE_URL="postgresql://postgres@localhost:5432/mcl_test"
npm run test:e2e
```

Clear any stale `.data/inbox` first and make sure no foreign server holds the port —
both have faked regressions here before.

**Step 3: Deploy and verify the deployed artefact**

Follow `docs/deploy/vps-mc-legends.md` end to end, including the restart check and the
real-UI submission at `https://srv1308064.hstgr.cloud:8443/#frage`. A green CI run is
not evidence that the container reached the socket with the real injected password.

**Step 4: Open the PR**

```bash
git push -u origin feat/MCL-48-postgres-submission-persistence
gh pr create --repo DYAI2025/MC_legends --base main \
  --title "MCL-48: durable PostgreSQL submission persistence on the VPS" \
  --body "$(cat <<'BODY'
Implements MCL-48. Text submissions are persisted in PostgreSQL 17 on
srv1308064.hstgr.cloud behind the existing SubmissionInboxStore port; the positive ACK
is minted only after the row is committed.

- Idempotency moves from a file scan to a PRIMARY KEY plus ON CONFLICT DO NOTHING
- Versioned SQL migrations with an idempotent runner
- /api/health/ready checks the database separately from /api/health
- The app reaches PostgreSQL over a bind-mounted Unix socket; the DB port stays
  loopback-only and no firewall or listen_addresses change is involved
- Rollback: remove DATABASE_URL from app.env and restart; the file store and its
  JSONL are untouched

AC 7 (validated off-VPS restore) is complete only once the drill table in
docs/ops/MCL-48-backup-restore.md carries a real row.
BODY
)"
```

**Step 5: Report against the acceptance criteria**

Post the AC-by-AC result to MCL-48, separating observed facts from what is still
planned, and say plainly which validations were not run.

---

## Validation summary

| Check | Command | Expected |
|---|---|---|
| Foundation | `npm run check:foundation` | exit 0 |
| Secrets | `npm run check:secrets` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Types | `npm run typecheck` | exit 0 |
| Unit + contract | `npm run test` | all pass; contract runs for both adapters |
| Integration | `MCL_TEST_DATABASE_URL=… npm run test` | Postgres suite runs, does **not** skip |
| Build | `npm run build` | exit 0 |
| E2E | `E2E_PORT=3100 DATABASE_URL=… npm run test:e2e` | all specs pass |
| Deployed app | `curl -sk https://srv1308064.hstgr.cloud:8443/api/health` | `{"status":"ok"}` |
| Deployed DB | `curl -sk https://srv1308064.hstgr.cloud:8443/api/health/ready` | `{"app":"ok","database":"ok"}` |
| Durability | `docker restart mc-legends` then `select count(*)` | unchanged count |
| Exposure | `sudo ss -tlnp \| grep 5432` | only `127.0.0.1:5432` and `[::1]:5432` |
| Restore | `pg_restore` into a scratch DB on Berlin | row count matches source |
