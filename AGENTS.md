# Agent Instructions

## Source of truth

1. Jira project `MCL` owns backlog scope, issue status, sprint scope, acceptance criteria and unresolved product decisions.
2. `docs/architecture/` records the current bootstrap architecture and its review triggers.
3. Code and tests record implemented behavior. Do not promote planned Jira behavior to "implemented" without executable evidence.

## Non-negotiable project rules

- Do not select Fabric, NeoForge, another Minecraft loader, or a standalone-game engine until MCL-1 is resolved.
- Do not introduce Harry Potter, Hogwarts, Hogwarts Legacy, or recognizably derivative franchise assets/references.
- Preserve submitted original text/audio as immutable source artifacts. Derived/transcribed/normalized representations must be separate.
- Never show "Im Projekt angekommen" without a server acknowledgement.
- No server/service keys or private secrets in browser code.
- The inbox write path stays behind the server-side family session gate (MCL-34). A missing or blank `AVALORIA_FAMILY_ACCESS_CODE` must fail closed - never fall back to open access. See `docs/security/MCL-34-family-access.md`.
- Do not describe the process-local rate limiter or the file-store idempotency as production-grade or distributed.
- UI/application code must depend on persistence ports, not concrete persistence implementations.
- Prefer events/APIs over invasive hooks in a future Minecraft module; loader-specific rules belong in a future decision after MCL-1.

## Delivery rules

- Test acceptance behavior first or in the same change.
- Keep one Jira story or coherent technical slice per implementation change.
- Do not add estimates; delivery is performed by Codex and Claude Code agents unless the Product Owner changes this policy.
- Do not commit directly to the default branch. Use a dedicated work branch and PR.
- Do not merge, weaken branch rules, or bypass failing gates without explicit authorization.

## Required checks

Before proposing a merge, run the checks available for the changed scope:

```bash
npm run check:foundation
npm run check:secrets
npm run lint
npm run typecheck
npm run test
npm run build
npm run check:client-secrets   # after build, with the same AVALORIA_* values the build had
npm run test:e2e
```

`check:client-secrets` needs `AVALORIA_FAMILY_ACCESS_CODE` in the environment and a
completed build; it refuses to run without either, so it cannot report a vacuous pass.
`npm run dev` and `npm run test:e2e` also need a family access code - see `.env.example`.

If a check cannot run, report it as `not_run` with the concrete reason. Never convert an unexecuted check into a pass.
