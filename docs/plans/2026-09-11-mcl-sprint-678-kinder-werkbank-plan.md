# Sprint 678 "Kinder-Werkbank" (MCL Sprint 3) — Sprint Plan and Implementation Plan

> **For Claude / Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement the story sections (§7–§13) task-by-task, one story per work branch and PR. Sections §1–§6 and §14–§19 are the Product Owner's sprint contract and are not executed by an agent.

**Goal:** A child speaks an idea about a creature it can see with real artwork on the website, and within 24 hours gets a readable and read-aloud reply with exactly one question — which it can answer by voice straight from the reply card. The loop child → project → child closes end-to-end with a human in the loop; nothing in this sprint needs an LLM, a transcription model or an external provider.

**Sprint:** Jira sprint 678 "MCL Sprint 3 – Kinder-Werkbank" on board 370 · **Mon 2026-09-14 → Fri 2026-09-25** (10 working days) · Team: Ben (Product Owner + delivery) with Codex / Claude Code agents · **Capacity 10 PT** (stated by Ben, 2026-09-11) · **Planned load 7.5 PT = 75 %** · Stretch +3.5 PT.

**Baseline:** `origin/main` = `894dff7b12d883437818538c50ffff249c9b27ad` ("Merge pull request #38 from DYAI2025/feat/MCL-65-automated-external-backups", 2026-09-03), verified with `git fetch --dry-run` on 2026-09-11. Gates on this baseline are **`not_run`** in the planning session (no Node 24.18.1 available there) — run them on Day 1 and record the result in §2.

**Sources of truth:** Jira MCL-71…79, MCL-54/55/51 (scope, AC, status) · Confluence 13B "Kinder-Werkbank" (page 56885250; decisions D1–D3, loop model, reply contract) · Pareto-Kern analysis 2026-09-11 (Claude project "MCL-Protoype", `pareto-kern-sprint-1.md`) · this repo (`AGENTS.md`, `CLAUDE.md`, code and tests on `origin/main`).

---

## 0. Handoff separation (CLAUDE.md rule)

### Observed / implemented facts (read from `origin/main` @ 894dff7 on 2026-09-11)

| Fact | Where |
|---|---|
| Migrations on main: `0001_submission_inbox.sql`, `0002_submission_audio.sql`, `0003_question_lifecycle.sql`. **Next number is 0004.** | `db/migrations/` |
| `Submission` is a discriminated union `TextSubmission \| AudioSubmission`; `questionId` is a required non-blank string; no transcript field exists by design. | `src/domain/submissions/submission.ts` |
| The family write route validates `questionId` only for non-blank and `length ≤ 200`; it does **not** check it against the question dataset. So a `reply:<submissionId>` questionId already passes the write path unchanged. Same for the audio route (header `x-avaloria-question-id`). | `src/app/api/inbox/submissions/route.ts`, `.../audio/route.ts` |
| `submission_inbox.question_id` is `text` with `char_length ≤ 200`; index `(question_id, received_at DESC)` exists — a chain query by `questionId` is already indexed. | `db/migrations/0001_submission_inbox.sql` |
| Read and write are separate ports by trust boundary: `SubmissionInboxStore.appendIfAbsent` (family write) vs `SubmissionInboxReader.list/find` (admin read, newest-first, `MAX_INBOX_PAGE_SIZE = 200`, filter by `status`, `kind`, `questionId`, `limit`). | `src/application/submissions/*` |
| Every persistence port has a **file adapter and a PostgreSQL adapter**, selected in `src/composition/server.ts` by `DATABASE_URL`; e2e runs against the file adapters (`playwright.config.ts` sets `AVALORIA_*_DIR`, no database). | `src/adapters/persistence/*`, `playwright.config.ts` |
| Guards: `guardFamilyRequest(request, gate, rateLimiter)` and `guardAdminRequest(...)` return `"granted" \| "unauthorized" \| "rate-limited" \| "unavailable"`; routes refuse from headers alone before touching a body or store. Route error bodies are `{ error: "<slug>" }`. | `src/adapters/http/*-request-guard.ts`, admin routes |
| Admin POST pattern exists (question lifecycle): guard → `readBoundedJson(request, 16 KiB)` → validate → append → `409` on stale state. | `src/app/api/admin/questions/[questionId]/route.ts` |
| Composition root exports factories per port and reads every `AVALORIA_*` variable; blank counts as unset (`\|\|`). Rate limiters: `createProtectedRouteRateLimiter` (family inbox, 30/min), `createAdminRouteRateLimiter` (60/min), audio 10/min. | `src/composition/server.ts` |
| "Meine Ideen" on the family page lists **only text submissions from the browser-local IndexedDB** (`repository.list()` typed `TextSubmission[]`); audio answers are not in that list — the recorder shows its own send state. The question label for an answer comes from `questionById(questionId)`; an unknown id renders `answerBelongsToEarlierQuestionMessage`. | `src/app/family-experience.tsx` L102, L182–200, L265–270, L498–556 |
| `AudioAnswerRecorder` takes `questionId: string` as its only prop and rebinds the prepared recording when it changes. | `src/app/components/audio-answer-recorder.tsx` L44–83 |
| Admin inbox card shows original text or an `<audio>` element served by `/api/admin/inbox/submissions/[submissionId]/audio`, plus "Systemangaben" (`questionId`, `kind`). No reply UI exists. | `src/app/components/admin-inbox-view.tsx` L292–361 |
| `TruthStatus` already contains `TENTATIVE`; `childStatusFor` maps it to `ChildStatus "idea"`. `avaloriaIdeas` has 18 entries and none of Mugosh, Eis-Mugosh, Flammenwolf, Veras, Steinwolf, Zhalm, Elementarspeer. `childUnsafeVocabulary` lives in `content-source.ts`; `expectChildSafe(text, context)` in `tests/support/child-safe.ts` adds technical words (HTTP, 500, 503, fetch, Timeout, Stack). | `src/content/content-source.ts`, `src/content/avaloria-content.ts`, `tests/support/child-safe.ts` |
| Secret names are policed in three places: `tests/architecture/boundaries.test.ts` (regex list, "use client" file list), `scripts/check-client-secrets.mjs`, and both env blocks in `.github/workflows/ci.yml` (build + client-secrets steps). `scripts/check-foundation.mjs` holds the required-path list. | those files |
| No `speechSynthesis` usage anywhere in `src/`. No `/api/family/*` content route (only `/api/family/session`). | `git grep` |
| `scripts/check-integration-tests-ran.mjs` does **not** enumerate suites: it runs everything under `tests/integration/` with a JSON reporter and fails when suites were skipped or nothing ran. A new suite is picked up automatically but must actually run in CI (`MCL_TEST_DATABASE_URL` set). | `scripts/check-integration-tests-ran.mjs` |
| MCL-protolab: all 4 PRs are **merged** (incl. "prototype runtime foundation (PlayCanvas 2.21.4)" and "private VPS test instance for world editor"); Confluence Protolab page still says "Draft-PRs offen" → stale (input to MCL-72). | github.com/DYAI2025/MCL-protolab/pulls |

### Jira-planned behavior (not implemented)

MCL-71 artwork entries · MCL-74 reply log, admin reply form, family reply route, reply card, read-aloud, delete script · MCL-75 `reply:<id>` answers and admin chain view · MCL-73 visibility ladder · MCL-78 measurement · MCL-79 decisions D4/D5. See §7–§13.

### Assumptions (to be replaced by measurement)

- Sprint capacity 10 PT is net of family time; the sprint plans 7.5 PT so that the Day-9 child test and Ben's own reply duty (≤ 24 h per submission) fit.
- The seven concept-art crops in `MCL-protolab/concepts/art-direction/crops/` (`mugosh`, `eis-mugosh`, `flammenwolf`, `veras`, each `-hero.png` and `-cut.png`) exist and are project-owned; Steinwolf, Zhalm and Elementarspeer have **no** approved artwork and ship with the emblem fallback.
- Two children share one family access code; therefore both see every reply of the household (§6, decision 4).

### Blockers / not_run

- Baseline gates (`npm run verify`, `npm run test:e2e`) on 894dff7: `not_run` in planning; Day-1 task.
- MCL-78 measurement: `not_run` until executed on the VPS (CPU/RAM unknown).
- MCL-79 decisions D4/D5: open; they block nothing in this sprint's P0/P1 scope by design.

---

## 1. Sprint goal and success measure

**Sprint goal (one sentence, Jira sprint 678):** Ein Kind spricht eine Idee zu einem Wesen ein, das es mit echtem Bild auf der Website sieht, und bekommt innerhalb von 24 Stunden eine vorlesbare Antwort mit genau einer Frage, die es direkt wieder einsprechen kann.

**Success measure (Y from the Pareto analysis):** ≥ 5 complete loop runs (submission → reply → follow-up recording with `questionId = reply:<id>`) in sprint week 2, counted in the admin inbox. Secondary: median reply latency ≤ 24 h; number of replies with a follow-up recording; gap reply → next recording (input to decision D5).

**Falsification built in:** < 2 submissions per week after MCL-71 ships means the children do not need automation yet (hypothesis H3) — Sprint 4 is re-planned around presentation, not the loop.

---

## 2. Capacity and load

| Person / role | Available days | Allocation | Notes |
|---|---|---|---|
| Ben — PO, review, Confluence, decisions, child tests | 10 of 10 | ≈ 3 PT | MCL-72, MCL-79, PR reviews, reply duty, Day-9 test evening |
| Ben + agents — implementation | 10 of 10 | ≈ 7 PT | one story per branch/PR; agent executes §7–§13 task-by-task |
| **Total** | **10** | **10 PT** | planned load 7.5 PT (75 %), stretch 3.5 PT |

**Baseline gates on Day 1 (fill in, never mark without running):**

| Gate | Command | Result on 894dff7 |
|---|---|---|
| Foundation + secrets + lint + typecheck + unit + build | `npm run verify` | not_run — |
| Integration (needs `MCL_TEST_DATABASE_URL`) | `npm run test && npm run check:integration-ran` | not_run — |
| Client bundle secret scan (after build) | `npm run check:client-secrets` | not_run — |
| E2E | `rm -rf .data && E2E_PORT=3199 npx playwright test` | not_run — |

---

## 3. Sprint backlog

| Prio | Jira | Item | Estimate | Owner | Dependencies | Day window | Branch |
|---|---|---|---|---|---|---|---|
| P0 | MCL-72 | Governance: 13B linked, pages 03/14/13/13A/Portal/Roadmap/Protolab reconciled, MCL-25 re-framed | 0.75 PT | Ben | — | Day 1–2 | (Confluence, no branch) |
| P0 | MCL-71 | Seven V2 creatures with approved artwork on the website | 1.5 PT | agent + Ben (assets) | MCL-72 (D1 documented) | Day 2–4 | `feat/MCL-71-creature-artwork` |
| P0 | MCL-74 | "Papa antwortet": reply log (file + Postgres), admin reply form, family reply route, reply card, read-aloud, delete script | 2.5 PT | agent + Ben | — | Day 3–7 | `feat/MCL-74-family-reply` |
| P0 | MCL-75 | Voice/text answer to a reply question (`questionId = reply:<id>`), admin chain view | 1.0 PT | agent | MCL-74 merged | Day 8–9 | `feat/MCL-75-reply-answer` |
| P0 | MCL-78 | Spike: whisper.cpp small/base timing on the VPS (timebox 0.5 PT) | 0.5 PT | Ben | VPS access | Day 5 | (ops, no product code) |
| P0 | MCL-79 | Decisions D4 (LLM provider / privacy default) and D5 (latency budget) on 13B | 0.25 PT | Ben | — | Day 3 | (Confluence) |
| P1 | MCL-73 | Visibility ladder "Stufe n von 5" with corrected rule and "Damit es weitergeht" | 1.0 PT | agent | MCL-71 merged; `nextSteps` content from Ben | Day 8–10 | `feat/MCL-73-visibility-ladder` |
| P2 (stretch) | MCL-54 | Transcript v1 on the VPS (only if MCL-78 = PASS and P0/P1 are merged by Day 8) | 3.5 PT | agent | MCL-78 PASS | Day 9–10 (start only) | `feat/MCL-54-transcript-v1` |

**Planned load: 7.5 PT of 10 PT (75 %).** Stretch: +3.5 PT (MCL-54) is explicitly *not* committed.

Cut order if the sprint runs late: MCL-54 → MCL-73 → MCL-75. MCL-74 is never cut; without it the sprint goal is not met.

---

## 4. Day plan

| Day | Date | Focus | Deliverable / checkpoint |
|---|---|---|---|
| 1 | Mon 14.09 | Sprint start (complete sprint 513 in Jira, start 678). Baseline gates on 894dff7 → §2. MCL-72 part 1: 13B link comment exists; page 03 "voxelartige" → SUPERSEDED; page 14 sentence → export rule. | Gate table filled; 2 Confluence versions |
| 2 | Tue 15.09 | MCL-72 part 2: page 13 delivery status, 13A traceability, Portal/Roadmap/Protolab status (all protolab PRs merged), MCL-25 re-framed. Assets for MCL-71: export WebP + `provenance.json` (Ben on the Mac, §8 A0). | MCL-72 done; 4 asset folders ready |
| 3 | Wed 16.09 | MCL-79: D4/D5 written into 13B §1 (D5 may stay "measure in sprint"). MCL-71 tasks A1–A4. MCL-74 tasks B0–B2 (domain, ports, migration) in parallel branch. | MCL-79 done; MCL-71 unit tests green |
| 4 | Thu 17.09 | MCL-71 A5–A7, PR, gates, screenshot → merge. MCL-74 B3–B4 (file + Postgres adapters, contract tests). | **MCL-71 merged** |
| 5 | Fri 18.09 | MCL-78 spike on the VPS (timebox 0.5 PT) → PASS/FAIL comment. **Mid-sprint check:** MCL-72/79/71 done? MCL-74 on track? Decide MCL-54 stretch go/no-go. MCL-74 B5–B6 (routes). | Spike verdict; go/no-go recorded in Jira sprint |
| 6 | Mon 21.09 | MCL-74 B7–B9 (admin form, family client + card, read-aloud). | Family reply visible in dev |
| 7 | Tue 22.09 | MCL-74 B10–B12 (delete script, e2e, gates, deploy to VPS via Coolify, migration 0004 applied) → merge. Ben answers the first real submissions. | **MCL-74 merged and live** |
| 8 | Wed 23.09 | MCL-75 C0–C4 → PR. MCL-73 D0–D2 (types, function, content). | MCL-75 PR open |
| 9 | Thu 24.09 | MCL-75 merge + deploy. **Child test evening:** both children record ideas, Ben replies the same evening, children answer the question. MCL-73 D3–D4. | ≥ 2 complete loop runs observed live |
| 10 | Fri 25.09 | MCL-73 PR + merge if green. Sprint review: count loop runs in the admin inbox, write `docs/plans/2026-09-25-mcl-sprint-678-review.md` (measurements, H1–H3 verdicts, D5 recommendation). Retro. Sprint 4 planning input. | Review doc; sprint 678 closed |

Ceremonies for a one-person team: Day-1 planning check (30 min), Day-5 mid-sprint check (20 min, written into the Jira sprint as a comment on MCL-74), Day-9 child test (the real demo), Day-10 review + retro (45 min, written).

---

## 5. Ground rules for every task (from `AGENTS.md`, `CLAUDE.md`, and the repo's plan convention)

- Node must be 24.18.1: `source ~/.nvm/nvm.sh && nvm use 24.18.1` before any npm command.
- One story per work branch and PR, branched from the current `origin/main`. Never commit to `main`. Never merge, weaken branch rules or bypass a failing gate without explicit authorization.
- Test acceptance behavior first or in the same change. Report every check as `PASS | FAIL | not_run: <reason> | BLOCKED`; an unexecuted check is never a pass.
- E2E runs with an isolated port and clean data: `rm -rf .data && E2E_PORT=3199 npx playwright test`.
- Every child-facing string goes through `expectChildSafe` (`tests/support/child-safe.ts`). No real children's names in fixtures, seeds, screenshots, commit messages or PR text.
- Original text and audio are immutable source artifacts. Replies are **separate, append-only, derived artifacts** and never touch `submission_inbox` rows.
- Secrets only in `src/composition/server.ts`; a new secret name is added to `tests/architecture/boundaries.test.ts`, `scripts/check-client-secrets.mjs` and both env blocks of `.github/workflows/ci.yml` in the same change.
- New `"use client"` components are listed in `tests/architecture/boundaries.test.ts`; new load-bearing files in `scripts/check-foundation.mjs`.
- UI and application code depend on ports, never on adapters. New wiring only in `src/composition/server.ts` / `browser.ts`.
- No game lore is invented. MCL-71 restates SSoT statements only; MCL-73 `nextSteps` come from Confluence 02A / MCL-35 questions.
- Do not add estimates to Jira issues (AGENTS.md); the PT numbers in this plan are the PO's planning figures, not agent estimates.

---

## 6. Design decisions (decided 2026-09-11, do not re-litigate during execution)

1. **Human reply before LLM reply.** MCL-74 stores a reply written by Ben. The data contract (`author: "human" | "llm"`, `status: "ready" | "fallback"`) is the same one MCL-76 will fill later, so the LLM only swaps the author. No `LlmPort` in this sprint.
2. **Reply is a separate append-only log, split by trust boundary.** `SubmissionReplyLog` (write; admin gate) and `SubmissionReplyReader` (read; family gate for the child view, admin gate for the card). Mirrors `SubmissionInboxStore` / `SubmissionInboxReader` and the question lifecycle log. File adapter + PostgreSQL adapter, both under one contract test, selected in `server.ts` exactly like the inbox.
3. **One `questionId` prefix for every reply context: `reply:<submissionId>`.** Not a second `echo:` format. The write routes already accept it (observed §0); only the family page's label function and the admin card need to understand it.
4. **Replies are read per household, not per child.** The family session is one code for the family; `GET /api/family/replies` returns the household's replies (latest `ready` reply per submission). Matching to "my" ideas happens client-side by submissionId where the local IndexedDB list knows the id, and every reply is shown in a dedicated "Antworten" list regardless — because audio ideas are not in the local list (observed §0). Documented limitation of the Family-MVP; a per-child profile is out of scope.
5. **Reply cards are persisted server-side and shown on every visit.** Polling exists only while the page is open (default 60 s, `document.hidden` pauses it). No countdown, no latency promise in the UI.
6. **Validation is a domain rule, vocabulary is an application rule.** `createReply` (domain) enforces shape: `understood` ≤ 2 sentences and ≤ 400 chars, `question` ends with exactly one `?` and ≤ 200 chars. `composeReply` (application) additionally runs `childUnsafeVocabulary` and the blocked-names list; both refusals map to `400 { error: "invalid-payload", reason }` in the admin route. The child route never sees a refused reply.
7. **Blocked names are a secret.** `AVALORIA_REPLY_BLOCKED_NAMES` (comma-separated, read only in `server.ts`, blank = no names) is treated like an access code in the three secret-policing places. Fixture tests use synthetic names only.
8. **Read-aloud is a browser adapter behind a port.** `SpokenTextReader` port; `BrowserSpeechSynthesisReader` adapter feature-detects `window.speechSynthesis`; the button is absent, not disabled, when unsupported. `lang = "de-DE"`, no autoplay, cancel on unmount.
9. **The replier label is a constant.** `FAMILY_REPLIER_LABEL = "Papa"` in `src/app/reply-message.ts`, with a comment that MCL-41 replaces it before any public release.
10. **Artwork is content, not code.** WebP files under `public/assets/creatures/<id>/` with a `provenance.json` sidecar; conversion happens offline on the Mac (no image dependency added to the repo). Entries without approved art keep `IdeaEmblem`.
11. **Delete path is PostgreSQL-only and dry-run by default.** `scripts/delete-submission.mjs <submissionId> [--apply]` prints what it would remove; `--apply` removes replies, the inbox row and the media object — the object only when no other row references the same `media_object_key` (content-addressed keys can be shared by identical bytes).
12. **Ladder without a next step is not shipped** (MCL-73). `visibilityStageFor` is pure; an entity gets the ladder UI only when it has ≥ 1 `nextSteps` entry.

---

## 7. MCL-72 — Governance (Confluence, Ben; 0.75 PT)

No repository change. Checklist, each item a Confluence page version with a version comment:

1. Page 03 (20512989) "Visuelle Originalität": mark "eigenständige voxelartige Fantasy-Bildwelt" as `V1 / SUPERSEDED (D1, 11.09.2026)`, link page 14 and 13B.
2. Page 14 (22544386): replace "Die Website ist jedoch nicht das Spiel selbst" by the 13B §2 boundary (presentation yes, runtime no; export path registry `approved_for_prototype` + commercial license → `MC_legends/public/assets/…` + provenance file; MCL-1 untouched).
3. Page 13 (21889039): "Aktueller Delivery-Stand" / "Infrastruktur-WIP" / "Nächste Reihenfolge" → MCL-30/49/64/65 Fertig, MCL-63 deferred, MCL-70 in progress; add 13B link. Page 13A (32735274) traceability: MCL-49 Fertig; note that reply/echo questions sit outside the publishing policy (13B §3).
4. Portal (20512943), Roadmap 10 (20480033), Protolab page (32604163): `MC_legends` main = `894dff7…` (PR #38, verified 11.09.); `MCL-protolab`: all four PRs merged (verified 11.09. on GitHub) — replace "Draft-PRs offen".
5. MCL-25: re-frame to V2 art direction; motif list aligned with page 14 and MCL-71.

Evidence: page version numbers + the GitHub readback (commit SHA, PR states) as a comment on MCL-72. Done = all five items commented with links.

---

## 8. MCL-71 — Seven V2 creatures with approved artwork (1.5 PT)

**Branch:** `feat/MCL-71-creature-artwork` from `origin/main`.

**Files:**
- Create: `public/assets/creatures/{mugosh,eis-mugosh,flammenwolf,veras}/{card.webp,hero.webp,provenance.json}`
- Create: `src/app/components/idea-artwork.tsx` (server component, no `"use client"`)
- Modify: `src/content/content-source.ts` (add `ArtworkRef`), `src/content/avaloria-content.ts` (7 entries + `artwork`), `src/app/family-experience.tsx` (card renders artwork or emblem), `src/app/welt/[id]/page.tsx` (detail renders artwork or emblem), `src/app/components/idea-emblem.tsx` (comment), `scripts/check-foundation.mjs` (+ `idea-artwork.tsx`)
- Modify tests: `tests/unit/avaloria-content.test.ts`, `tests/e2e/world-detail.spec.ts`

### Task A0 — Assets (Ben, Mac, Day 2)

1. From `MCL-protolab/concepts/art-direction/crops/` take `<id>-cut.png` (card) and `<id>-hero.png` (hero/detail) for mugosh, eis-mugosh, flammenwolf, veras.
2. Convert offline: `cwebp -q 82 -resize 640 0 <id>-cut.png -o card.webp` and `cwebp -q 82 -resize 1280 0 <id>-hero.png -o hero.webp` (`brew install webp`). Record the resulting pixel sizes.
3. Write `provenance.json` per folder:
   ```json
   {
     "assetId": "creature-flammenwolf-concept-v2",
     "source": "MCL-protolab/concepts/art-direction/crops/flammenwolf-cut.png",
     "sheet": "MCL-protolab/concepts/art-direction/flammenwolf.md",
     "license": "project-owned",
     "approvedOn": "2026-08-23",
     "approvedIn": "MLOA page 02 (20250626), section Flammenwolf",
     "negativeListChecked": { "list": "docs/image-negative-list.md", "by": "Ben", "on": "2026-09-15" },
     "files": { "card": { "width": 640, "height": 0 }, "hero": { "width": 1280, "height": 0 } }
   }
   ```
   (fill real heights; the unit test reads them).
4. Check every image against `docs/image-negative-list.md` (no owl, letter, seal, school motifs) and set `negativeListChecked`.
5. No Tripo free-tier renders, no GLB, nothing without a `provenance.json`.

### Task A1 — `ArtworkRef` type (failing test first)

`tests/unit/avaloria-content.test.ts`, new `describe("artwork")`:
- every idea with `artwork` has `src` starting with `/assets/creatures/`, `alt` non-empty and `expectChildSafe(alt, ...)`, `license === "project-owned"`, `approvedOn` ISO date, positive `width`/`height`;
- for every such idea the files `public${artwork.src}` and the sibling `provenance.json` exist on disk (`node:fs`), and `provenance.json.license === "project-owned"` and `negativeListChecked.by` is set;
- the seven ids `mugosh`, `eis-mugosh`, `flammenwolf`, `veras`, `steinwolf`, `zhalm`, `elementarspeer` exist with the expected `internalCategory`, `childCategory` and `truthStatus` (`TENTATIVE` only for `eis-mugosh`);
- an idea without `artwork` still renders through the emblem (covered by existing emblem test; add the assertion that `steinwolf`, `zhalm`, `elementarspeer` have no `artwork`).

Implementation in `content-source.ts`:
```ts
export type ArtworkRef = Readonly<{
  src: `/assets/creatures/${string}`;
  alt: string;
  width: number;
  height: number;
  assetId: string;
  license: "project-owned";
  provenance: string; // path to provenance.json, e.g. "/assets/creatures/flammenwolf/provenance.json"
  approvedOn: string; // ISO date
}>;
```
and `artwork?: ArtworkRef` on the idea type (optional, never required).

### Task A2 — Seven entries in `avaloria-content.ts`

One entry per entity; `source` uses the existing `SourceReference` helpers pointing at MLOA page 02 (20250626) / PvE page (32735234) with a `note` naming the section. Text = restated SSoT sentences only (short child-facing summary already approved on those pages). `eis-mugosh`: `truthStatus: "TENTATIVE"`, note "OPEN_QUESTION 2 in 13B". Categories: `creatures` → "Wesen & Figuren"; `elementarspeer` → `crafting` → "Ausrüstung & Bauen". Run the test; it must fail on the missing files until A0 is in place, then pass.

### Task A3 — `IdeaArtwork` component

`src/app/components/idea-artwork.tsx`: server component; props `{ artwork: ArtworkRef; variant: "card" | "hero" }`; renders `next/image` with the recorded `width`/`height`, `alt` from the ref, `sizes` for card vs hero, `loading="lazy"` for cards. No client hooks. Unit test not needed beyond the content test; the e2e covers rendering.

### Task A4 — Card and detail rendering

`family-experience.tsx` idea card: `idea.artwork ? <IdeaArtwork artwork={idea.artwork} variant="card" /> : <IdeaEmblem ... />`. `welt/[id]/page.tsx`: hero variant, plus the existing source line. Keep the "Konzeptbild · noch nicht fest" badge only on emblem cards.

### Task A5 — E2E

`tests/e2e/world-detail.spec.ts`: `/welt/flammenwolf` shows `img[alt]` whose `src` contains `/assets/creatures/flammenwolf/`, title, status "Schon dabei" and the source line; back link restores the "Wesen & Figuren" filter (existing behavior). Overview with filter "Wesen & Figuren" lists the six creatures; "Ausrüstung & Bauen" lists the spear. `/welt/steinwolf` renders the emblem `svg`.

### Task A6 — Emblem comment + foundation list

Update the comment in `idea-emblem.tsx`: the emblem is the fallback for entities without approved artwork (D1, 13B). Add `src/app/components/idea-artwork.tsx` to `scripts/check-foundation.mjs`.

### Task A7 — Gates and PR

`npm run verify` · `npm run check:client-secrets` (after build, with the same `AVALORIA_*` values) · `rm -rf .data && E2E_PORT=3199 npx playwright test`. PR body: screenshot of the overview (synthetic data only), the seven ids, the provenance check, gate results as `PASS | FAIL | not_run`.

---

## 9. MCL-74 — "Papa antwortet" (2.5 PT)

**Branch:** `feat/MCL-74-family-reply` from `origin/main` (rebase after MCL-71 merges; no file overlap except `check-foundation.mjs`).

**Files:**
- Create: `db/migrations/0004_submission_reply.sql`
- Create: `src/domain/replies/reply.ts`
- Create: `src/application/replies/submission-reply-log.ts`, `src/application/replies/submission-reply-reader.ts`, `src/application/replies/compose-reply.ts`, `src/application/replies/family-reply-client.ts`, `src/application/replies/admin-reply-client.ts`, `src/application/media/spoken-text-reader.ts`
- Create: `src/adapters/persistence/file-submission-reply-log.ts`, `src/adapters/persistence/postgres-submission-reply-log.ts`
- Create: `src/adapters/http/http-family-reply-client.ts`, `src/adapters/http/http-admin-reply-client.ts`, `src/adapters/media/browser-speech-synthesis-reader.ts`
- Create: `src/app/api/family/replies/route.ts`, `src/app/api/admin/inbox/submissions/[submissionId]/replies/route.ts`
- Create: `src/app/components/family-replies.tsx` (`"use client"`), `src/app/components/admin-reply-form.tsx` (`"use client"`), `src/app/reply-message.ts`
- Create: `scripts/delete-submission.mjs`, `docs/ops/MCL-74-family-reply.md`
- Modify: `src/composition/server.ts`, `src/composition/browser.ts`, `src/app/family-experience.tsx`, `src/app/components/admin-inbox-view.tsx`, `scripts/check-foundation.mjs`, `scripts/check-client-secrets.mjs`, `tests/architecture/boundaries.test.ts`, `.github/workflows/ci.yml`, `.env.example`
- Tests: `tests/unit/reply.test.ts`, `tests/unit/compose-reply.test.ts`, `tests/unit/submission-reply-log-contract.ts` (+ file and Postgres suites), `tests/unit/family-replies-route.test.ts`, `tests/unit/admin-replies-route.test.ts`, `tests/unit/reply-message.test.ts`, `tests/integration/postgres-submission-reply-log.test.ts`, `tests/integration/delete-submission.test.ts`, `tests/e2e/family-reply.spec.ts`

### Task B0 — Migration `0004_submission_reply.sql` (write it first; the Postgres suite depends on it)

```sql
CREATE TABLE submission_reply (
  reply_id       text        PRIMARY KEY,
  submission_id  text        NOT NULL REFERENCES submission_inbox (submission_id),
  understood     text        NOT NULL,
  question       text        NOT NULL,
  question_id    text        NOT NULL,
  author         text        NOT NULL,
  status         text        NOT NULL,
  created_at     timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submission_reply_author_known    CHECK (author IN ('human', 'llm')),
  CONSTRAINT submission_reply_status_known    CHECK (status IN ('ready', 'fallback')),
  CONSTRAINT submission_reply_understood_len  CHECK (char_length(understood) BETWEEN 1 AND 400),
  CONSTRAINT submission_reply_question_len    CHECK (char_length(question) BETWEEN 2 AND 200),
  CONSTRAINT submission_reply_question_shape  CHECK (question LIKE '%?'),
  CONSTRAINT submission_reply_question_id     CHECK (question_id = 'reply:' || submission_id),
  CONSTRAINT submission_reply_id_length       CHECK (char_length(reply_id) <= 200)
);
CREATE INDEX submission_reply_submission_recent_idx ON submission_reply (submission_id, created_at DESC);
CREATE INDEX submission_reply_recent_idx ON submission_reply (created_at DESC);
```
Append-only: no UPDATE/DELETE path in the adapter; the delete script is the only remover. `question_id` is stored, not derived, so a row is self-describing when read by an import or by `psql`.

### Task B1 — Domain `src/domain/replies/reply.ts` (failing tests in `tests/unit/reply.test.ts`)

Types:
```ts
export type ReplyAuthor = "human" | "llm";
export type ReplyStatus = "ready" | "fallback";
export type SubmissionReply = Readonly<{
  replyId: string; submissionId: string; understood: string; question: string;
  questionId: `reply:${string}`; author: ReplyAuthor; status: ReplyStatus; createdAt: string;
}>;
export type CreateReplyInput = Readonly<{ submissionId: string; understood: string; question: string; author: ReplyAuthor }>;
export class ReplyShapeError extends Error { constructor(readonly reason: ReplyShapeReason, ...) }
export type ReplyShapeReason = "understood-blank" | "understood-too-long" | "understood-too-many-sentences" | "question-blank" | "question-too-long" | "question-not-single";
export function replyQuestionId(submissionId: string): `reply:${string}`;
export function isReplyQuestionId(value: string): value is `reply:${string}`;
export function createReply(input: CreateReplyInput, deps: { createId: () => string; now: () => Date }): SubmissionReply;
```
Rules (tests): understood trimmed, 1–400 chars, ≤ 2 sentences (count terminators `.`, `!`, `?` followed by space/end; an ellipsis "…" counts once); question trimmed, 2–200 chars, exactly one `?` and it is the last character; `replyQuestionId("abc") === "reply:abc"`; `status` is always `"ready"` from this factory (fallback is produced only by the future LLM path). Frozen object.

### Task B2 — Ports and application rules

`submission-reply-log.ts`: `interface SubmissionReplyLog { append(reply: SubmissionReply): Promise<void> }` (throws `ReplyTargetError` when the submission does not exist — Postgres surfaces the FK violation 23503 as this error; the file adapter checks the inbox file).
`submission-reply-reader.ts`:
```ts
export type ReplyView = Readonly<{ reply: SubmissionReply; submission: Readonly<{ submissionId: string; kind: SubmissionKind; questionId: string; createdAt: string; originalTextExcerpt: string | null }> }>;
export interface SubmissionReplyReader {
  latestForHousehold(query: Readonly<{ since?: string; limit?: number }>): Promise<readonly ReplyView[]>; // latest ready reply per submission, newest first, limit ≤ 100
  listForSubmission(submissionId: string): Promise<readonly SubmissionReply[]>;           // all replies, oldest first (admin history)
}
```
`originalTextExcerpt`: first 120 chars of `original_text` for `kind = 'text'`, `null` for audio.
`compose-reply.ts`: `composeReply(input, deps: { forbiddenVocabulary: readonly string[]; blockedNames: readonly string[]; createId; now })` → `{ ok: true, reply } | { ok: false, reason: ReplyShapeReason | "unsafe-vocabulary" | "blocked-name" }`; word-boundary, case-insensitive match (same regex shape as `childUnsafeMentions`). Tests in `tests/unit/compose-reply.test.ts` with synthetic names (`"Testkind"`), never real ones.
`family-reply-client.ts` (browser port): `list(since?: string): Promise<FamilyReplyResult>` with outcomes `granted | denied | unavailable | transport` (mirror `AdminInboxResult`).
`admin-reply-client.ts`: `list(submissionId)`, `post(submissionId, draft: { understood; question })` → outcomes incl. `invalid` with `reason`.
`spoken-text-reader.ts`: `interface SpokenTextReader { readonly supported: boolean; speak(text: string, lang: "de-DE"): void; cancel(): void }`.

### Task B3 — File adapter + contract test

`tests/unit/submission-reply-log-contract.ts` exports `describeSubmissionReplyLogContract(factory)`; it is run by `tests/unit/file-submission-reply-log.test.ts` and by the Postgres integration test. Contract: append then `listForSubmission` returns it; two appends keep order; `latestForHousehold` returns only the newest per submission and only `status = "ready"`; `since` filters by `createdAt`; `limit` caps and is clamped at 100; append for an unknown submission throws `ReplyTargetError`; original text excerpt is ≤ 120 chars; audio submission yields `originalTextExcerpt: null`.
`file-submission-reply-log.ts`: JSONL under `AVALORIA_REPLY_DIR` (default `.data/replies`), one file `replies.jsonl`, `O_APPEND` writes, same shape discipline as `inbox-record-shape.ts`; reads the inbox JSONL via the existing `SubmissionInboxReader` handed in by composition (no cross-adapter import). Implements both ports in one class (as the question lifecycle log does), returned under two factory names.

### Task B4 — PostgreSQL adapter + integration test

`postgres-submission-reply-log.ts` using `postgres-pool.ts`; `INSERT` maps 23503 → `ReplyTargetError`; `latestForHousehold` uses `DISTINCT ON (submission_id)` ordered by `created_at DESC`, joined to `submission_inbox` for `kind`, `question_id`, `created_at`, `left(original_text, 120)`; `listForSubmission` ordered by `created_at ASC, reply_id ASC`.
`tests/integration/postgres-submission-reply-log.test.ts` runs the contract against `MCL_TEST_DATABASE_URL` (skips without it locally; in CI the variable is set, so `check:integration-ran` counts it — a skipped suite there is a red gate, not a pass). Uses the existing table-lock helper from `tests/support/submission-inbox-table-lock.ts` if the suites share the database.

### Task B5 — Admin route `POST/GET /api/admin/inbox/submissions/[submissionId]/replies`

`POST`: guard from headers → `readBoundedJson(request, 16 * 1024)` → `{ understood, question }` strings → `composeReply(...)` with `author: "human"` → `createSubmissionReplyLog().append` → `201 { reply }` with `cache-control: no-store`. Refusals: `400 { error: "invalid-payload", reason }`, `401 unauthorized`, `404 { error: "unknown-submission" }` (ReplyTargetError), `429`, `503 { error: "replies-unavailable" }`. Never echoes the blocked name back in the body (reason code only).
`GET`: guard → `listForSubmission` → `200 { replies }`.
Unit tests (`tests/unit/admin-replies-route.test.ts`) with a fake log via composition selection as in `admin-inbox-route.test.ts`: happy path, each refusal, and "the response body never contains a configured name".

### Task B6 — Family route `GET /api/family/replies?since=<iso>&limit=<n>`

Guard with `guardFamilyRequest(request, createFamilyAccessGate(), createProtectedRouteRateLimiter())` → `latestForHousehold` → `200 { replies: ReplyView[] }` with `cache-control: no-store`; `since` must parse as an instant or `400`; `limit` refused (not clamped) above 100 as the inbox route does. Snapshot test pins the response shape: keys are exactly `reply.{replyId,submissionId,understood,question,questionId,author,createdAt}` and `submission.{submissionId,kind,questionId,createdAt,originalTextExcerpt}` — **no** `status` other than implied `ready`, no admin fields, no receipt ids. `401` without a family session; an unknown `since` format `400`; store failure `503 { error: "replies-unavailable" }`.

### Task B7 — Composition and secrets

`server.ts`: `createSubmissionReplyLog()`, `createSubmissionReplyReader()` (file vs Postgres by `DATABASE_URL`, directory `AVALORIA_REPLY_DIR`), `replyBlockedNames()` reading `AVALORIA_REPLY_BLOCKED_NAMES` (comma-separated, trimmed, blank = `[]`), `createFamilyReplyRateLimiter()` = reuse `createProtectedRouteRateLimiter` unless measured otherwise. `browser.ts`: `createBrowserFamilyReplyClient()`, `createBrowserAdminReplyClient()`, `createBrowserSpokenTextReader()`.
Secret policing in the same commit: `AVALORIA_REPLY_BLOCKED_NAMES` added to the regex list in `boundaries.test.ts`, to `check-client-secrets.mjs`, to both env blocks in `ci.yml` (canary value `ci-canary-blocked-name-2f8e`), and to `.env.example` with a comment. `boundaries.test.ts` "use client" list: `family-replies.tsx`, `admin-reply-form.tsx`. `check-foundation.mjs`: the new domain/application/adapter files and both components.

### Task B8 — Admin reply form

`admin-reply-form.tsx` (`"use client"`): two fields "Verstanden (max. 2 Sätze)" and "Eine Frage an dich (genau ein Fragezeichen)", live counters, submit disabled while sending; on `invalid` shows the reason in adult language (German), on success prepends the reply to the card's history. Mounted inside `AdminInboxCard` below "Systemangaben", with the history from `GET .../replies` loaded lazily per card (one request per expanded card, not per page load). Unit test for the reason → sentence mapping; e2e in B11.

### Task B9 — Family reply card + read-aloud

`reply-message.ts`: `FAMILY_REPLIER_LABEL = "Papa"`; sentences `replyUnderstoodLead()` → "Papa hat verstanden:", `replyQuestionLead()` → "Eine Frage an dich:", `replyStatusPill()` → "Eine Idee – Papa hat geantwortet", `replyEmptyMessage()` → "Noch keine Antwort. Papa schaut sich deine Ideen an.", `replyForAudioIdea(date)` → "Zu deiner Sprachidee vom <Tag>." All through `expectChildSafe` in `tests/unit/reply-message.test.ts`.
`family-replies.tsx` (`"use client"`): loads on mount via the client port, polls every 60 s while `!document.hidden`, renders a list "Antworten" of cards: lead + `understood`, lead + `question`, pill (uses the `idea` presentation, never `in-world`), original excerpt or audio sentence, and a "Vorlesen" button when `reader.supported` (speaks `understood + " " + question`, cancels on unmount). Transport failures render nothing new and keep the last list (no error jargon). `prefers-reduced-motion`: no spinner, static "Ich schaue nach …" text while loading. Mounted in `family-experience.tsx` under the "Meine Ideen" section as its own `<section id="antworten">` (only when `familySessionActive`). In the local "Meine Ideen" list, an entry whose id has a reply gets a small "Papa hat geantwortet ↓" link to the card.

### Task B10 — Delete script

`scripts/delete-submission.mjs <submissionId> [--apply]` (Postgres via `DATABASE_URL`, `AVALORIA_MEDIA_DIR` for the blob): prints reply count, inbox row (kind, object key), and whether the object key is shared; with `--apply` runs in one transaction: `DELETE FROM submission_reply`, `DELETE FROM submission_inbox`, then unlinks the media object only if no remaining row references it; logs each step. Exit code non-zero when the submission does not exist. `tests/integration/delete-submission.test.ts` proves it against Postgres with a synthetic text submission + reply and an audio submission whose object key is shared by a second row (the file must survive). Documented in `docs/ops/MCL-74-family-reply.md` together with the new env variables and the household-visibility limitation.

### Task B11 — E2E `tests/e2e/family-reply.spec.ts`

Runs against the file adapters on the standard e2e server: sign in as family (`signInAsFamily`), submit a text idea, sign in as admin in a second context (`tests/support/admin-session.ts` pattern), post a reply through the real form; back in the family context reload → the "Antworten" card shows exactly one question and the pill; `expectChildSafe` on every visible string in the section; the "Vorlesen" button exists in Chromium (speechSynthesis present) — click does not throw; without a family session `GET /api/family/replies` → 401 (API-level check); a reply with two questions is refused in the admin form with a visible reason. Uses `E2E_PORT=3199` and clean `.data`.

### Task B12 — Gates, deploy, first replies

Gates as in §5 plus `npm run test && npm run check:integration-ran` with `MCL_TEST_DATABASE_URL`. Deploy via Coolify (see `docs/deploy/vps-mc-legends.md`), run `npm run db:migrate` for 0004 on the VPS, set `AVALORIA_REPLY_DIR` (unused with Postgres but harmless) and `AVALORIA_REPLY_BLOCKED_NAMES` in the Coolify secrets, verify `/api/health/ready`. Ben answers every open submission the same day. Restart drill: restart the container and confirm replies persist. Record all of it as `PASS | FAIL | not_run` in the PR and in `docs/ops/MCL-74-family-reply.md`.

---

## 10. MCL-75 — Answer a reply question by voice or text (1.0 PT)

**Branch:** `feat/MCL-75-reply-answer` from `origin/main` after MCL-74 merged.

**Files:** Modify `src/app/components/family-replies.tsx`, `src/app/family-experience.tsx`, `src/app/reply-message.ts`, `src/app/components/admin-inbox-view.tsx`; tests `tests/unit/reply-message.test.ts`, `tests/e2e/family-reply.spec.ts` (extend), `tests/integration/postgres-submission-inbox-store.test.ts` (chain query assertion).

### Task C0 — Label for reply-context answers

`answerQuestionLabel(questionId)` in `family-experience.tsx`: if `isReplyQuestionId(questionId)` return `answerToReplyMessage()` ("Deine Antwort auf Papas Frage") instead of the "earlier question" sentence. Unit-test the message; keep `question-lifecycle.spec.ts` green (no change to rotation or `focusQuestion()`).

### Task C1 — "Antworten" on the reply card

Each card gets an "Antworten" toggle that reveals `<AudioAnswerRecorder questionId={reply.questionId} />` and a small text form bound to the same `questionId` (reusing `submitText` + `deliverSubmission` exactly as the focus-question form does, with the same child messages). The focus-question form and recorder above stay untouched.

### Task C2 — Admin chain view

In `AdminInboxCard`, when `entry.questionId` starts with `reply:`, render "Antwort auf Idee <id>" as a button that sets the inbox filter `questionId` to that id's reply chain (`reply:<id>`), and on the origin card a "Kette anzeigen" button that filters by `questionId = reply:<own id>`. No new route: the existing `questionId` filter and index carry the chain. Show the last 5 links inline (newest first, as the reader orders).

### Task C3 — Tests

E2E: after B11's reply, click "Antworten", submit a text answer → "Meine Ideen" shows it with the reply label and the arrived status after ACK; admin filter by `reply:<id>` lists it. Integration: `reader.list({ questionId: "reply:<id>" })` returns only chain members, newest first.

### Task C4 — Gates + PR

As §5; `question-lifecycle.spec.ts`, `family-mvp.spec.ts`, `audio-capture.spec.ts` must stay green.

---

## 11. MCL-78 — Transcription measurement gate (Ben, VPS, Day 5, timebox 0.5 PT)

1. `nproc; lscpu | head -20; free -m; df -h /opt/mc-legends/data` — record.
2. Build or install whisper.cpp on the host (not in the app container); models `ggml-base.bin` and `ggml-small.bin` on a volume outside the repo and outside any image.
3. Generate 60 s of synthetic German speech (macOS `say -v Anna` → AIFF → `ffmpeg` to 16 kHz WAV; adult voice; no real names) and copy it to the VPS.
4. `whisper-cli -m <model> -l de -f sample.wav` three times per model; record wall time min/median/max and peak RSS (`/usr/bin/time -v`).
5. Verdict in a comment on MCL-78: PASS if `small` median ≤ 60 s; else FAIL with the `base` numbers, set MCL-77 to mandatory and comment on MCL-54. Nothing leaves the VPS; timebox 4 h — stop with a partial result if exceeded.

---

## 12. MCL-79 — Decisions D4 / D5 (Ben, Day 3, 0.25 PT)

Write into Confluence 13B §1 with date: **D4** = LLM/embedding provider and privacy default (options a local / b external with zero retention under MCL-66 / c hybrid; recommendation a). **D5** = latency budget ("24 h is enough" vs "< 3 min") — may be recorded as "measured in sprint 678, decided at review". Comment on MCL-76, MCL-51, MCL-55 with the outcome; leave the blocker links until D4 is decided.

---

## 13. MCL-73 — Visibility ladder (P1, 1.0 PT)

**Branch:** `feat/MCL-73-visibility-ladder` from `origin/main` after MCL-71 merged.

**Files:** Modify `src/content/content-source.ts`, `src/content/avaloria-content.ts`, `src/app/family-experience.tsx`, `src/app/welt/[id]/page.tsx`, `src/app/globals.css`; tests `tests/unit/avaloria-content.test.ts`, `tests/e2e/world-detail.spec.ts`.

### Task D0 — Types and labels
```ts
export type VisibilityStage = 0 | 1 | 2 | 3 | 4 | 5;
export const visibilityStageLabels = { 0: "Schatten", 1: "Skizze im Kopf", 2: "Gezeichnet", 3: "Gestalt", 4: "In der Welt", 5: "Lebendig" } as const satisfies Record<VisibilityStage, string>;
```
Optional idea fields `model?`, `worldPlacement?`, `clip?` (typed refs, unused this sprint) and `nextSteps?: ReadonlyArray<string>`.

### Task D1 — Pure function + tests
`visibilityStageFor(idea)` = highest `n` such that all conditions 1…n hold: (1) `truthStatus` is `STATED` or `TENTATIVE`; (2) `STATED` and `artwork`; (3) `model`; (4) `worldPlacement`; (5) `clip`. Tests pin: mugosh/flammenwolf/veras → 2; steinwolf/zhalm/elementarspeer → 1; eis-mugosh → 1 while `TENTATIVE` even with artwork; `validateIdea` rejects `clip` without `artwork` (artifact monotonicity); an idea with a ladder must have ≥ 1 `nextSteps` (decision 12).

### Task D2 — Content
`nextSteps` for the seven entities: child-friendly phrasing of the open `QUESTION` entries from Confluence 02A / the MCL-35 questions for that entity (max 3, each through `expectChildSafe`). Ben supplies the source list on Day 8; an entity without any open question ships **without** the ladder (rule), not with an invented one.

### Task D3 — UI
Card: "Stufe n von 5" as text plus a 5-segment bar (`role="img"`, `aria-label` = same text; never colour-only). Detail: the same plus "Damit es weitergeht, fehlt:" list. CSS in `globals.css`, `prefers-reduced-motion` safe (no animation anyway).

### Task D4 — E2E + gates
`/welt/mugosh` shows "Stufe 2 von 5" and the "Damit es weitergeht" list; `/welt/steinwolf` shows "Stufe 1 von 5". Gates as §5.

---

## 14. MCL-54 — Stretch entry criteria (not committed)

Start only if all of: MCL-78 = PASS, MCL-71/74/75 merged by Day 8, MCL-73 at least in PR. Then follow the Jira description (migration `0005_submission_transcript.sql`, `TranscriptionPort`, `WhisperCppTranscriber`, worker script, admin display, delete-script extension). Otherwise it is the first item of Sprint 4.

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Ben cannot keep the ≤ 24 h reply duty in week 2 | The sprint goal is missed even with green code; children learn "nothing comes back" | Reply duty is a calendar block (20 min, evenings Day 7–10); the card shows no countdown; if two days pass, a fallback sentence "Papa schaut sich deine Ideen an" stays honest |
| Household-wide reply visibility (decision 4) surprises a child ("das ist nicht meine Idee") | Confusion, not a privacy breach (same family session) | Cards carry the original excerpt / audio date; per-child profiles are a Sprint-4+ candidate if the test evening shows friction |
| `speechSynthesis` has no German voice on the family device | Read-aloud silently useless | Button only when a `de-DE` voice or any voice exists; text remains; test on the actual device on Day 9 |
| Asset export (A0) slips because the Protolab crops need re-cropping | MCL-71 blocks MCL-73 | A0 is Day 2 and Ben-owned; MCL-74 proceeds in parallel; MCL-73 is P1 |
| New integration suite skips in CI (missing table, wrong env) | `check:integration-ran` goes red | Migration 0004 is applied by the CI `db:migrate` step before `npm run test`; B4 asserts the suite ran, not only passed |
| FK on `submission_reply.submission_id` conflicts with the JSONL import path (`import-inbox-jsonl.mjs`) | Import order matters after a restore | Restore runbook: inbox first, replies second; documented in `docs/ops/MCL-74-family-reply.md` |
| Blocked-names list catches a creature name ("Veras") by accident | Ben's reply refused | Name list is exact-word; creature names are in `avaloriaIdeas` and the compose test asserts no idea title is blocked |
| MCL-78 shows the VPS is too slow | Sprint 4 transcript plan changes | It changes nothing in this sprint; it decides MCL-77 = mandatory |
| Over-planning for one person (this document) | Time spent on the plan, not the loop | Sections §7–§13 are executed by agents; Ben's own items are §7, §11, §12 and the assets |

---

## 16. Definition of Done

**Per PR (MCL-71, MCL-74, MCL-75, MCL-73):**
- [ ] Acceptance criteria of the Jira issue covered by tests written first or in the same change
- [ ] `npm run verify` PASS · `npm run check:client-secrets` PASS after build · `npm run test:e2e` PASS on an isolated port · integration suites PASS with `MCL_TEST_DATABASE_URL` and `check:integration-ran` PASS (where the change touches persistence)
- [ ] Every child-facing string through `expectChildSafe`; no real names anywhere
- [ ] New client components / files / secret names registered in the four policing places (§5)
- [ ] PR body separates observed facts, Jira-planned behavior, assumptions and `not_run` checks (CLAUDE.md)
- [ ] Reviewed and merged by the Product Owner; branch deleted; Jira issue moved to Fertig with the PR link

**Sprint 678 done:**
- [ ] MCL-74 and MCL-75 live on the VPS with migration 0004 applied and a restart drill recorded
- [ ] ≥ 2 complete loop runs observed on the Day-9 test evening; count for week 2 recorded on Day 10
- [ ] `docs/plans/2026-09-25-mcl-sprint-678-review.md` written: measurements, H1–H3 verdicts, D5 recommendation, carry-over
- [ ] Confluence 13B §8 and Jira sprint 678 closed with the same numbers

---

## 17. Key dates

| Date | Event |
|---|---|
| Mon 14.09 | Sprint start; complete sprint 513; baseline gates |
| Wed 16.09 | MCL-79 decisions recorded |
| Thu 17.09 | MCL-71 merged |
| Fri 18.09 | Mid-sprint check; MCL-78 verdict; MCL-54 go/no-go |
| Tue 22.09 | MCL-74 merged and live; first real replies |
| Thu 24.09 | MCL-75 live; child test evening (the demo) |
| Fri 25.09 | Sprint review + retro; review doc; sprint closed |

---

## 18. Measurement plan (feeds Sprint 4 and decision D5)

Counted from the admin inbox (`GET /api/admin/inbox/submissions` with `questionId` filters) and `submission_reply`:

| Metric | How | Decides |
|---|---|---|
| Submissions per week (before MCL-71 vs after) | count by `received_at` week | H1/H3: does artwork alone move usage? |
| Replies per week, median latency submission → reply | `submission_reply.created_at − submission_inbox.received_at` | Ben's reply duty is feasible? |
| Share of replies with a follow-up recording | rows with `question_id` matching the reply's context identifier (`reply:<original-submission-id>`) in `submission_inbox` | Y (loop runs) |
| Gap reply → next recording (median) | join on `reply:<id>` | D5: is "hours" enough, or is the LLM echo (MCL-76) required? |
| Read-aloud button usage | none this sprint (no analytics by design) | — |

---

## 19. Sprint 4 candidates by outcome

- Gap reply → next recording mostly < 1 day and children keep recording → MCL-76 (LLM echo, mode `review`) is optional; prioritise MCL-73 polish, MCL-54 (if PASS), Slice 5 (paid GLB tier).
- Children stop after one exchange unless the reply comes within the session (H2) → MCL-79 D5 = "< 3 min", MCL-76 becomes P0 with D4 decided; MCL-54 required for audio.
- < 2 submissions/week (H3) → presentation first: MCL-73, Slice 5, story chapters; automation deferred.

---

*Plan written 2026-09-11 from Jira, Confluence 13B and `origin/main` @ 894dff7. Everything marked `not_run` stays so until executed; do not convert an unexecuted check into a pass.*
