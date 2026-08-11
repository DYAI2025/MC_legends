# MC Legends / Avaloria

This repository contains the web foundation for the MCL Minecraft-Legends project.

## Current architecture decision

The current foundation is a **modular Next.js web monolith with ports and adapters**.
It deliberately does **not** select Fabric, NeoForge, a Minecraft loader, or a standalone-game engine.
Jira MCL-1 still owns the unresolved product-format decision and explicitly keeps loader/framework selection out of scope until that decision is made.

The web foundation is designed so that a later Minecraft module can be added without moving submission/domain logic into framework code.

## Why this foundation

Sprint 1 requires browser-local submission persistence and truthful local status.
Sprint 2 introduces a server inbox/acknowledgement boundary.
A single Next.js deployable can host the web UI now and route handlers later, while the application layer depends only on a `SubmissionRepository` port.
Concrete persistence stays behind adapters:

- Sprint 1: IndexedDB adapter in the browser.
- Sprint 2: server-inbox adapter behind the same application boundary.
- Later: Supabase server adapter if and when its contract is approved.

No Supabase SDK, database, queue, auth provider, container platform, or Minecraft loader is added without a Jira-backed driver.

## Toolchain

- Node.js 24.18.1
- npm 11.x (package metadata pins 11.17.0)
- Next.js 16.2.12
- React 19.2.8
- TypeScript 6.0.3
- ESLint 9.39.5 with `eslint-config-next` 16.2.12
- Vitest 4.1.10
- Playwright 1.62.0

## Local setup

```bash
nvm install
nvm use
npm install
npm run verify
npx playwright install chromium
npm run test:e2e
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AVALORIA_INBOX_DIR` | `.data/inbox` | Directory the server inbox appends `submissions.jsonl` to. A blank value falls back to the default. |

`AVALORIA_INBOX_DIR` is the only environment variable this app reads. On a platform with an ephemeral filesystem (Railway) the default directory does not survive a redeploy — the acknowledgement is real, the stored copy is not durable. Point the variable at a mounted volume, or accept that the inbox is per-deploy until the authenticated read side lands.

### Lockfile gate

This generated foundation currently has no `package-lock.json` because the execution environment could not reach the npm registry during generation.
The **first networked development run must execute `npm install` and commit the generated `package-lock.json` before merge**.
CI treats the committed lockfile as a required reproducibility gate.

## Architecture boundaries

```text
src/domain             framework-free domain model and invariants
       ^
src/application        use cases and ports
       ^
src/adapters           browser/server/integration implementations
       ^
src/composition        wiring of concrete adapters
       ^
src/app                Next.js delivery layer
```

Rules are exercised by `tests/architecture/boundaries.test.ts`.

## Current foundation behavior

The runtime page is intentionally only a shell plus `/api/health`.
It does not claim that Sprint 1 business stories are already implemented.
The domain and IndexedDB adapter are prepared and unit-tested for MCL-40.

## Validation

Run:

```bash
npm run check:foundation
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

See `docs/architecture/VALIDATION.md` for what was actually executed during generation.

## Project truth hierarchy used for this bootstrap

- Jira MCL: product scope, issue status, sprint scope and unresolved decisions.
- Architecture records in `docs/architecture`: bootstrap decision and review triggers.
- GitHub: implementation, commits, PRs and CI evidence once the remote repository is initialized.
- Confluence: no MCL-specific page was located through the connected searches during this run; this is recorded as an evidence gap, not proof that no such page exists.

## Agent entry points

- `AGENTS.md` - repository-wide rules for coding agents.
- `CLAUDE.md` - Claude Code entry point, delegating to the same repository rules.
- `docs/project/JIRA_BASELINE_2026-08-11.md` - Jira scope snapshot used by this foundation.
- `docs/architecture/ADR-0001-web-foundation.md` - architecture decision.
# MC_legends
