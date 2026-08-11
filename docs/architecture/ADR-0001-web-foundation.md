# ADR-0001 - Modular Next.js web foundation with ports/adapters

- Status: **Conditional / accepted for the web foundation**
- Date: 2026-08-11
- Decision owner: project bootstrap under explicit user authorization
- Review trigger: Jira MCL-1 resolution or a new independently operated backend/hosting constraint

## Context

The MCL backlog requires an immediately testable browser-local flow in Sprint 1 and introduces a server inbox/acknowledgement boundary in the next delivery slice. MCL-22/MCL-33 require persistence seams so that later server/Supabase storage does not force UI reconstruction. MCL-1 leaves the actual Minecraft-vs-standalone product-format decision open and therefore blocks a loader/engine commitment.

## Hard constraints

1. Do not select a Minecraft loader/engine before MCL-1 is resolved.
2. Browser-local persistence must work without server availability for the Sprint-1 slice.
3. The UI/application layer must not know concrete persistence details.
4. A later server acknowledgement must be representable without changing the domain meaning of local-only state.
5. No private server/service credentials in frontend code.
6. Keep original submission artifacts immutable.
7. Do not introduce unnecessary distributed-system operations before there is a driver.

## Considered options

### A. React/Vite SPA + separate API service later

Pros:
- smallest pure-client runtime for Sprint 1,
- clean static deployment option,
- backend can be independently operated later.

Costs:
- Sprint 2 immediately creates a second project/runtime/deployment surface,
- duplicated configuration/contract handling arrives before independent operation is required,
- cross-runtime integration testing is needed sooner.

### B. Next.js modular monolith + ports/adapters - selected

Pros:
- one web deployment unit while Sprint 1 is browser-local,
- route-handler/server boundary is available for Sprint 2 without a second service,
- domain/application modules remain independent of Next.js,
- IndexedDB, server inbox and future Supabase can be concrete adapters behind the same port,
- later extraction remains possible because boundaries are enforced in tests.

Costs:
- UI and server delivery share a deployment unit,
- a truly static-only product would carry unnecessary server-framework capability,
- boundary discipline needs architecture tests to prevent framework leakage.

### C. Polyglot monorepo now: Web + API + Supabase + Fabric/NeoForge module

Rejected for the current state.
It commits to infrastructure and Minecraft loader decisions for which Jira has not established drivers and directly gets ahead of MCL-1.

## Decision

Use a single **Next.js 16 web application** as the current deployment unit. Keep business concepts in framework-independent `domain` and `application` modules. Persistence/integration implementations live in `adapters`; concrete wiring lives in `composition`; Next.js remains the delivery layer.

Sprint 1's concrete persistence adapter is browser IndexedDB. A server-inbox adapter and later Supabase adapter may be added only behind the existing port and only when their Jira slices are active.

No Minecraft loader module is scaffolded yet. The repository layout intentionally leaves that future addition reversible.

## Strongest counterargument

If MCL-1 or hosting evidence establishes that Avaloria is a static/offline-first web client with an independently owned backend, React/Vite plus a separately deployable API would create a cleaner deployment boundary and avoid coupling server delivery to Next.js.

This counterargument becomes decisive when any of these occur:

- backend ownership/release cadence must be independent,
- hosting forbids or materially penalizes a persistent Node/Next runtime,
- offline conflict-resolution becomes a primary product capability,
- MCL-1 chooses a product topology where the web experience is only a static companion.

## Consequences

- Architecture tests enforce dependency direction.
- No Supabase dependency until its adapter story is active.
- No auth provider until the server-read trust boundary is implemented.
- No container/Kubernetes/queue/cache by default.
- The decision remains conditional at project level until MCL-1 is resolved.
