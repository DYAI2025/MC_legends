# Claude Code Project Memory

Read `AGENTS.md` first and treat it as the repository-wide operating contract.

## Architecture

The current web foundation is a modular Next.js monolith with ports/adapters:

- `src/domain` - framework-free types/invariants
- `src/application` - use cases and ports
- `src/adapters` - concrete persistence/integration adapters
- `src/composition` - wiring
- `src/app` - Next.js UI/API delivery

The Minecraft product-format/loader choice is deliberately unresolved until Jira MCL-1 is decided.

## Commands

```bash
npm run dev
npm run check:foundation
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

## Handoff rule

Every handoff must separate:

- observed/implemented facts,
- Jira-planned behavior,
- assumptions,
- blockers/not-run validation.
