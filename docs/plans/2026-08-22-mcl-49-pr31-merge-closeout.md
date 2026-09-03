# MCL-49 / PR #31 — authorized merge and merge-closeout evidence

**Date:** 2026-08-22
**Repository:** `DYAI2025/MC_legends`
**PR:** [#31](https://github.com/DYAI2025/MC_legends/pull/31) — "MCL-49: original audio in private, durable storage"
**Authorized reviewed head:** `a3f296a1ba4bc6bba582f15ed78e593200f91d1d`
**Verified base:** `108441783052d1695b636579004677d0c85cb04b`
**Upstream verdict:** independent orchestrator re-review complete → READY FOR MERGE; F1 and F2 accepted.

This is an **integration plan**, not an implementation plan. No source file in `src/`, `tests/`, `scripts/` or `docs/` is edited by any task below. The only mutations are: one PR-description edit and one merge.

---

## Goal

Merge PR #31 into `main` at exactly the authorized reviewed head, with the PR description reconciled to that head first, and return a machine-checkable post-merge evidence packet.

## Non-goals (explicit — do not do these)

| # | Forbidden |
|---|---|
| NG-1 | Rebase, amend, force-push, or create any new code commit on `feat/MCL-49-private-audio-storage` |
| NG-2 | Bypass branch protection (`--admin`, protection edits, force merge) |
| NG-3 | Synthesize an approval that GitHub requires from a human |
| NG-4 | Deploy to VPS / Coolify |
| NG-5 | Touch Jira (no transition, no comment, no field edit) |
| NG-6 | Claim MCL-49 is Done — the runtime/Coolify AC is still open |
| NG-7 | Begin MCL-30B or any follow-on story |
| NG-8 | Commit the dirty working tree (`CLAUDE.md`, `.claude/`, the two `docs/plans/2026-08-21-*.md` files, this plan file) |
| NG-9 | Fix the failing Cloudflare `Workers Builds` check (out of scope; see R-2) |

---

## Requirements (REQ IDs used by the tasks)

| REQ | Statement |
|---|---|
| REQ-M1 | Merge happens only if PR #31 is still OPEN and its head is exactly `a3f296a…f91d1d` |
| REQ-M2 | Merge happens only if `origin/main` is still exactly `1084417…c85cb04b` |
| REQ-M3 | Merge happens only if the PR is mergeable and every **required** status check on the reviewed head is successful |
| REQ-M4 | Merge happens only if there are no unresolved review threads |
| REQ-M5 | PR description carries a final verification section bound to the reviewed head, and no longer says "Do not merge" |
| REQ-M6 | PR description keeps the existing architectural explanation intact |
| REQ-M7 | The merge is atomically conditional on the expected head SHA (server-side, not a read-then-write race) |
| REQ-M8 | The repository's normal merge-commit strategy is used |
| REQ-M9 | A closeout evidence packet is returned: PR state + `mergedAt`, merge SHA, new `origin/main` SHA, ancestry proof, main CI run + terminal result, failed/pending main checks, working-tree status |

---

## Preconditions and known gaps

### Verified at plan time (2026-08-22, read-only)

| Precondition | Observed | Command that produced it |
|---|---|---|
| PR OPEN, not draft | `"state":"OPEN"`, `"isDraft":false` | `gh pr view 31 --json state,isDraft` |
| head == authorized | `a3f296a1ba4bc6bba582f15ed78e593200f91d1d` | `gh pr view 31 --json headRefOid`; `git ls-remote origin refs/heads/feat/MCL-49-private-audio-storage` |
| main == verified base | `108441783052d1695b636579004677d0c85cb04b` | `git ls-remote origin refs/heads/main` |
| branch not behind main | `git merge-base origin/main a3f296a` == `1084417…` == `origin/main` | `git merge-base` |
| mergeable | `"mergeable":"MERGEABLE"` | `gh pr view 31 --json mergeable` |
| required checks green | protection requires **only** `verify`; `verify` = `success`, `head_sha == a3f296a…` | `gh api …/branches/main/protection`; `gh api …/actions/runs/32529511658` |
| review threads | `totalCount: 0` | GraphQL `reviewThreads` |
| required approvals | protection has **no** `required_pull_request_reviews` block; `enforce_admins:false`; `required_conversation_resolution:false` | `gh api …/branches/main/protection` |
| merge strategy | `allow_merge_commit:true`; `main` history is "Merge pull request #N from …" for #12, #24, #26, #27, #28 | `gh api repos/…`; `git log origin/main --merges` |

### Known gaps carried into the merge (do not attempt to close here)

- **G-1 — `Workers Builds: mc-legends` is `failure` on the reviewed head.** It is a Cloudflare Workers build integration, **not** in `required_status_checks` (`contexts: ["verify"]`). It is the sole reason `mergeStateStatus` reads `UNSTABLE` rather than `CLEAN`. `UNSTABLE` does not block a merge under this protection config. Related prior finding in local memory: `opennext-cloudflare-pg-root-cause` (`copyWorkerdPackages` needs `serverExternalPackages`; `deploy` never builds). Out of scope.
- **G-2 — main's own CI history is not a clean signal.** The last main commit (`1084417`) carries exactly one check run, `verify`, with conclusion **`cancelled`** (concurrency cancellation, not a failure). Expect the same shape post-merge; see T5 and R-3.
- **G-3 — runtime/Coolify AC remains outstanding.** `AVALORIA_MEDIA_DIR` is unset on the running container and no nginx vhost sets `client_max_body_size`. AC2/AC9 are not runtime-proven. This is why NG-6 holds.
- **G-4 — the working tree is dirty** (`M CLAUDE.md`, `?? .claude/`, `?? docs/plans/2026-08-21-mcl-49-completion-upload-playback-backup.md`, `?? docs/plans/2026-08-21-mcl-sprint-513-family-mvp-2-completion.md`, plus this file). It stays dirty; T6 reports it verbatim.
- **G-5 — the PR body's verification table is bound to `a135e2b`.** T2 does not rewrite that table; it appends a head-bound section that supersedes it and removes the "Do not merge" line.
- **G-6 — `delete_branch_on_merge: false`.** The branch survives the merge. Leave it; deleting it is not authorized here.

---

## Task list

### T1 — Re-read live GitHub state immediately before merge (gate)

- **REQ:** REQ-M1, REQ-M2, REQ-M3, REQ-M4
- **Files/modules:** none (read-only)
- **Run:**

```bash
gh pr view 31 --json number,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName
git ls-remote origin refs/heads/main refs/heads/feat/MCL-49-private-audio-storage
gh api repos/DYAI2025/MC_legends/branches/main/protection --jq '.required_status_checks.contexts'
gh api repos/DYAI2025/MC_legends/commits/a3f296a1ba4bc6bba582f15ed78e593200f91d1d/check-runs \
  --jq '.check_runs[] | {name,conclusion,head_sha}'
gh api graphql -f query='query{repository(owner:"DYAI2025",name:"MC_legends"){pullRequest(number:31){reviewThreads(first:50){totalCount nodes{isResolved isOutdated path}}}}}'
```

- **Acceptance evidence (all must hold, verbatim values):**

| Assertion | Expected |
|---|---|
| `state` | `OPEN` |
| `isDraft` | `false` |
| `headRefOid` | `a3f296a1ba4bc6bba582f15ed78e593200f91d1d` |
| `refs/heads/feat/MCL-49-private-audio-storage` | `a3f296a1ba4bc6bba582f15ed78e593200f91d1d` |
| `refs/heads/main` | `108441783052d1695b636579004677d0c85cb04b` |
| `mergeable` | `MERGEABLE` |
| required contexts | `["verify"]` |
| `verify` on `a3f296a` | `conclusion: success`, `head_sha: a3f296a1ba4bc6bba582f15ed78e593200f91d1d` |
| unresolved threads | `totalCount: 0`, or every node `isResolved: true` |

- **STOP conditions — abort the whole plan, report, change nothing:**
  - head ≠ `a3f296a…f91d1d`
  - `refs/heads/main` ≠ `1084417…c85cb04b`
  - `state` ≠ `OPEN`
  - `mergeable` ≠ `MERGEABLE`
  - a **required** context (currently only `verify`) is not `success` on the reviewed head
  - any unresolved review thread exists
- **Not a stop condition:** `mergeStateStatus: UNSTABLE` caused solely by the non-required `Workers Builds: mc-legends` failure (G-1). Record it; proceed. If `mergeStateStatus` becomes `BLOCKED`, `BEHIND`, or `DIRTY`, that **is** a stop.

### T2 — Reconcile PR metadata only

- **REQ:** REQ-M5, REQ-M6
- **Files/modules:** PR #31 description only. **No branch, no commit, no file in the repo.**
- **Method:** read the current body to a scratch file, edit that copy, push it back with `gh pr edit --body-file`. Compose → re-read → send.

```bash
SCRATCH=/private/tmp/claude-501/-Users-benjaminpoersch-Projects-MC-legends/<session>/scratchpad
gh pr view 31 --json body -q .body > "$SCRATCH/pr31-body-before.md"
cp "$SCRATCH/pr31-body-before.md" "$SCRATCH/pr31-body-after.md"
# 1. delete the single line that reads: **Do not merge** — this implementation has had no independent diff review.
# 2. append Appendix A verbatim (see below), directly before the "🤖 Generated with" line
gh pr edit 31 --body-file "$SCRATCH/pr31-body-after.md"
gh pr view 31 --json body -q .body > "$SCRATCH/pr31-body-verify.md"
```

- **Acceptance evidence:**

| Check | Command | Expected |
|---|---|---|
| "Do not merge" gone | `grep -c "Do not merge" "$SCRATCH/pr31-body-verify.md"` | `0` |
| new section present | `grep -c "repaired reviewed head" "$SCRATCH/pr31-body-verify.md"` | `1` |
| head SHA present | `grep -c "a3f296a1ba4bc6bba582f15ed78e593200f91d1d" "$SCRATCH/pr31-body-verify.md"` | `1` |
| architecture text preserved | `grep -c "The order is the load-bearing part" "$SCRATCH/pr31-body-verify.md"` | `1` |
| nothing else lost | `/usr/bin/diff "$SCRATCH/pr31-body-before.md" "$SCRATCH/pr31-body-verify.md"` | only the removed "Do not merge" line and the added Appendix A block |
| head unmoved | `gh pr view 31 --json headRefOid -q .headRefOid` | `a3f296a1ba4bc6bba582f15ed78e593200f91d1d` |
| working tree unchanged by T2 | `git status --short` | identical to the T0 snapshot |

> Evidence rule: use `/usr/bin/diff` by absolute path, and do not accept a shimmed `diff`/`head` summary as proof (see the RTK finding in the global operating notes). `grep -c` returning an integer is the primary evidence here.

### T3 — Merge, conditional on the expected head

- **REQ:** REQ-M7, REQ-M8
- **Files/modules:** none locally; server-side merge only.
- **Run:**

```bash
gh pr merge 31 --merge --match-head-commit a3f296a1ba4bc6bba582f15ed78e593200f91d1d
```

- **Why this form:** `--match-head-commit` sends `sha=` to `PUT /repos/{o}/{r}/pulls/31/merge`, so GitHub itself refuses with **HTTP 409** if the head moved between T1 and T3. That is the atomic condition REQ-M7 demands — a read-then-merge sequence is not.
- **Flags that must NOT appear:** `--admin` (NG-2), `--squash`, `--rebase` (NG/REQ-M8), `--delete-branch` (G-6), `--auto` (defers the merge past this session and defeats T4).
- **Acceptance evidence:** command exits 0 and prints a merge confirmation. Immediately follow with T4 — the exit code alone is not the evidence.
- **STOP conditions — report, do not retry, do not escalate:**
  - HTTP 409 / "Head branch was modified" → head moved; the authorization no longer applies.
  - "At least N approving review(s) required" / "Changes must be approved by a reviewer" → a human-only approval is required. **Report it. Do not synthesize an approval, do not self-approve, do not use `--admin`** (NG-3, NG-2).
  - "Required status check … is expected/failing" → re-read protection; if a new required context appeared since T1, stop.
  - Merge queue required → stop and report; do not bypass.

### T4 — Post-merge evidence: PR, merge SHA, main SHA, ancestry

- **REQ:** REQ-M9
- **Run:**

```bash
gh pr view 31 --json state,merged,mergedAt,mergeCommit,headRefOid,url
git fetch origin --quiet
git ls-remote origin refs/heads/main
git rev-parse origin/main
git merge-base --is-ancestor a3f296a1ba4bc6bba582f15ed78e593200f91d1d origin/main; echo "ancestor_exit=$?"
git log origin/main --oneline -n 3
```

- **Acceptance evidence:**

| Field | Expected |
|---|---|
| `state` | `MERGED` |
| `merged` | `true` |
| `mergedAt` | non-null ISO-8601 timestamp — report verbatim |
| `mergeCommit.oid` | the exact merge SHA — report verbatim |
| `origin/main` | the new SHA — report verbatim; must equal `mergeCommit.oid` for a merge-commit merge into `main` |
| ancestry proof | `ancestor_exit=0` (an integer, not a judgement) |
| main tip subject | `Merge pull request #31 from DYAI2025/feat/MCL-49-private-audio-storage` |

- **If `ancestor_exit=1`:** the reviewed head is *not* in main. Stop and report — do not "fix" it.

### T5 — Post-merge main CI: run identity, terminal result, failed/pending checks

- **REQ:** REQ-M9
- **Run** (`NEW_MAIN` = the SHA from T4):

```bash
gh api repos/DYAI2025/MC_legends/actions/runs \
  --jq ".workflow_runs[] | select(.head_sha==\"$NEW_MAIN\") | {name,event,status,conclusion,html_url,id}"
gh api "repos/DYAI2025/MC_legends/commits/$NEW_MAIN/check-runs" \
  --jq '.check_runs[] | {name,status,conclusion}'
~/.claude/scripts/gh-ci-wait DYAI2025/MC_legends "$NEW_MAIN" 900; echo "ci_wait_exit=$?"
```

- **Wait policy:** wait only for the **actual terminal result within this session**. `gh-ci-wait` exit codes: `0` = all runs success, `1` = failure, `2` = timeout/none. Do not hand-roll a poll loop with inline JSON parsing.
- **Acceptance evidence:**
  - the workflow run(s) whose `head_sha` equals the new main SHA, each with `status`, `conclusion`, `html_url`, reported verbatim;
  - `ci_wait_exit` as an integer;
  - every check run whose `conclusion` is not `success`, listed by name with its conclusion — **including `cancelled`, `skipped`, and still-`in_progress`**. If the list is empty, say "none" explicitly.
- **Interpretation guard (G-2):** on the previous main commit `1084417`, `verify` concluded **`cancelled`**. `cancelled` is neither pass nor fail — report it as `cancelled`, name the concurrency-cancellation hypothesis as a hypothesis, and do not restate it as green. If no run exists for the new main SHA (`ci_wait_exit=2` with no runs), report "no main CI run observed for `<sha>` within the wait window" — do not infer success.

### T6 — Working-tree status and packet assembly

- **REQ:** REQ-M9
- **Run:**

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

- **Acceptance evidence:** the raw `git status --short` output, verbatim. Expected to still show `M CLAUDE.md`, `?? .claude/`, the two `docs/plans/2026-08-21-*.md` files and this plan file — i.e. **unchanged by this task**, confirming NG-8 held. The local checkout is expected to still sit on `feat/MCL-49-private-audio-storage` at `a3f296a…`; the plan never checks out or fast-forwards `main` locally.
- **Then STOP.** Emit the evidence packet and end the task. No Jira, no deploy, no MCL-30B, no "MCL-49 Done" claim.

---

## Evidence packet (the deliverable shape of T4–T6)

```
PR #31           state / merged / mergedAt
merge SHA        <mergeCommit.oid>
new origin/main  <sha>            (== merge SHA)
ancestry         git merge-base --is-ancestor a3f296a… origin/main -> exit 0
main CI          <workflow name> <id> <status>/<conclusion> <html_url>
                 gh-ci-wait exit = <0|1|2>
non-success      <name: conclusion>, … | none
working tree     <git status --short, verbatim>
still open       runtime/Coolify AC (AVALORIA_MEDIA_DIR unset, nginx client_max_body_size unset,
                 AC2/AC9 not runtime-proven), retention policy AC11, MCL-30B browser send path
```

---

## Risks and rollback

| ID | Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|---|
| R-1 | Head or main moves between T1 and T3 | low | `--match-head-commit` makes GitHub reject the merge server-side (409) | nothing merged; re-run T1, report, wait for re-authorization |
| R-2 | `Workers Builds: mc-legends` failure is mistaken for a merge blocker, or is silently ignored | medium | It is **not** in `required_status_checks`. Proceed, but name it in the packet as a known-failing non-required check (G-1) | n/a |
| R-3 | Post-merge main `verify` is `cancelled` and gets read as green | medium (it was `cancelled` on `1084417`) | T5 interpretation guard: report `cancelled` as `cancelled` | n/a |
| R-4 | PR body edit loses architectural content | low | before/after `/usr/bin/diff` + four `grep -c` integer checks in T2; body-before file is kept in scratch | `gh pr edit 31 --body-file "$SCRATCH/pr31-body-before.md"` restores the exact prior body |
| R-5 | A human-only approval or merge queue is required | low (no `required_pull_request_reviews` observed) | T3 STOP condition; never `--admin`, never self-approve | nothing merged; report to the orchestrator gate |
| R-6 | Dirty working tree gets swept into a commit | low | NG-8; no task runs `git add`/`git commit`/`git push`; T6 proves the tree is unchanged | `git restore --staged .` if anything was staged; never commit `CLAUDE.md` here |
| R-7 | Merge lands but main CI never terminates in-session | medium | `gh-ci-wait` 900 s cap, then report `ci_wait_exit=2` honestly | **No rollback of the merge.** Reverting a merge to `main` is a separate, human-authorized decision — not part of this plan |
| R-8 | Post-merge revert is attempted reflexively on a red main | — | Out of scope by design | Escalate to the next orchestrator gate with the red evidence; do not `git revert` unprompted |

**Merge rollback stance, stated plainly:** once T3 succeeds, this plan has no rollback. A bad merge is undone by an explicit, separately authorized revert PR — never by a force-push to `main` (`allow_force_pushes: false` on protection anyway).

---

## Appendix A — exact text to append to the PR description (T2)

```markdown
## Final verification — bound to the repaired reviewed head

Repaired reviewed head: `a3f296a1ba4bc6bba582f15ed78e593200f91d1d`
(supersedes the `a135e2b`-bound verification table above)

- **F1 — hard 8 MiB ceiling: closed.** An oversized recording is refused before either store is touched.
- **F2 — transferred media digest verification: closed.** A media archive is checked against the source-generated manifest before a backup is called good.
- GitHub integration CI: green (`verify`, run 32529511658, head `a3f296a…f91d1d`).
- 569 tests.
- Integration gate: 62/62.
- Playwright: 88/88.
- ShellCheck: green.

**Still outstanding: the runtime/Coolify acceptance criterion.** `AVALORIA_MEDIA_DIR` is not set on the
running container and no nginx vhost sets `client_max_body_size`; AC2/AC9 are therefore not runtime-proven.
Merging this PR does not close MCL-49.
```

The numbers in Appendix A are **transcribed from the orchestrator brief**, not re-measured by this plan. If the executor re-runs the suites and gets different totals, report the measured values and stop — do not adjust the check to fit (per the global evidence rule).

---

## Handoff separation

- **Observed / verified facts:** everything in "Verified at plan time" — each row has the command that produced it.
- **Jira-planned behavior:** MCL-49 closes the *server side* of "Originalaudio privat und persistent auf VPS speichern". Jira is not touched by this plan.
- **Assumptions:** (a) the orchestrator's 569 / 62 / 88 / ShellCheck figures are correct as given — not re-measured here; (b) `Workers Builds: mc-legends` is a pre-existing Cloudflare-deploy failure unrelated to the merge gate — inferred from it being absent on the main-branch commit and absent from required contexts, **not** from reading its build log.
- **Blockers / not-run validation:** runtime/Coolify AC (G-3) `not_run: needs AVALORIA_MEDIA_DIR + redeploy + a real recording`; MCL-49 retention policy AC11 `BLOCKED: no period defined`; MCL-30B browser send path `not_run: out of scope`.
