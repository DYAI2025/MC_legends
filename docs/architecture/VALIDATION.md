# Foundation validation - 2026-08-11

## Result

**Maturity: `structurally_valid`**

Not claimed: `buildable`, `tested`, `runtime_verified`, `release_candidate`, or `production_ready`.

## Passed gates

### Structure guard

Command:

```text
node scripts/check-foundation.mjs
```

Result: passed (`foundation-structure: ok`).

The first run exposed a self-match bug in the franchise-reference guard. The checker was corrected to exclude its own rule source and the gate was re-run successfully. The initial failure is intentionally documented rather than hidden.

### Architecture Builder schemas

The following artifacts were validated with Python `jsonschema` 4.26.0 against the actual schemas under the installed `adaptive-boilerplate-architecture-builder` skill:

- `project-intake.json` -> `project-intake.schema.json`
- `architecture-decision.json` -> `architecture-decision.schema.json`
- `stack-adapter.json` -> `stack-adapter.schema.json`
- `build-manifest.json` -> `build-manifest.schema.json`

Result: all passed.

## Blocking gate

### Dependency install / adapter clean-build gate

Target command:

```text
npm install --no-fund
```

The install attempt reached the execution timeout without registry response. A bounded connectivity probe then returned:

```text
npm notice PING https://registry.npmjs.org/
npm error code EAI_AGAIN
npm error syscall getaddrinfo
npm error request to https://registry.npmjs.org/-/ping failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org
```

Therefore:

- no dependency install is claimed,
- no `package-lock.json` was fabricated,
- lint/typecheck/unit/build/e2e remain `not_run`,
- the stack adapter remains `conditional`, not `selectable` under the builder's strict adapter contract.

## Environment mismatch

Generator runtime:

- Node `22.16.0`
- npm `10.9.2`

Project target:

- Node `24.18.1`
- npm `11.x`

The target runtime could not be installed in the generator environment because external package/runtime downloads were unavailable.

## Required next validation on a networked Node 24 environment

```text
nvm install
nvm use
npm install
npm run verify
npx playwright install chromium
npm run test:e2e
```

Then commit the generated `package-lock.json`. CI intentionally requires a tracked, unchanged lockfile before merge.

## Supplementary static checks

These checks increase confidence but do **not** replace the required target-toolchain gates:

- `node scripts/check-secrets.mjs` -> passed (`secret-scan: ok`).
- Internal framework-free TypeScript modules (`domain`, `application`, `adapters`, `composition`) compile with the generator's global TypeScript 5.8.3 using a temporary config -> passed.
- `.github/workflows/ci.yml` and `.github/dependabot.yml` parse as YAML with the generator's PyYAML -> passed.

The full application typecheck still remains `not_run`, because it requires the pinned Next/React/TypeScript dependencies.

## GitHub delivery gate

Local branch/commit creation passed:

- branch: `chore/bootstrap-web-foundation`
- bootstrap content commit: `902603416ce242b2803a0358703ffc573953f8df`
- local worktree was clean immediately after that commit.

Remote branch creation was attempted with the GitHub connector using `main` as base and failed with:

```text
409 Git Repository is empty.
```

This is a **delivery blocker**, not permission ambiguity: repository preflight reported authenticated push/admin permission, but the remote contains no base commit/ref.
The bootstrap is therefore not claimed as pushed and no PR is claimed.
