# Source map - bootstrap 2026-08-11

## Project-internal evidence

- `EV-001` - Jira MCL-1: product format unresolved; no loader/framework choice in the decision issue.
- `EV-002` - Jira MCL-22: thin web architecture; persistence seams; original-vs-derived data separation; no frontend secrets.
- `EV-003` - Jira MCL-33: Local -> Server -> Supabase direction and persistence adapter boundary.
- `EV-004` - Jira MCL-37/MCL-38/MCL-40: Sprint-1 text/local persistence/truthful status acceptance evidence.
- `EV-005` - Jira MCL-34: server inbox trust-boundary/security requirements.
- `EV-006` - Connected Confluence search: no MCL-specific page located by the attempted queries.
- `EV-007` - GitHub repository read: `DYAI2025/MC_legends` exists, is writable to the authenticated connector, and is empty.

## External primary/version evidence

- `EV-008` - npm registry: Next.js `16.2.12` is the stable/latest package tag checked on 2026-08-11.
- `EV-009` - Node.js official release index: Node `24.18.1` is the current latest v24 build checked on 2026-08-11.
- `EV-012` - npm registry: React `19.2.8`, Vitest `4.1.10`, Playwright `1.62.0`, ESLint `9.39.5` maintenance and related dependency versions checked during adapter research.

## User/project decisions

- `EV-010` - Project conversation: Codex and Claude Code are the development agents; no effort estimation is required for agent coding.
- `EV-013` - User explicitly authorized boilerplate creation and GitHub commit/push for `DYAI2025/MC_legends`.

## Generator/runtime evidence

- `EV-011` - Generator container has Node `22.16.0`, npm `10.9.2`; npm registry lookup returns `EAI_AGAIN`, blocking install/build/runtime gates.

## Uploaded Minecraft-modding package

The supplied Unix Minecraft-modding skill supports Java 21/Gradle and Fabric-vs-NeoForge heuristics. It is retained as **future loader/toolchain evidence**, but it does not override Jira MCL-1. A loader choice now would be premature.
