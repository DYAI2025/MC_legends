import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    // MCL-35: the second Playwright dev server builds here (NEXT_DIST_DIR). Build output,
    // not source - and unignored it adds several hundred errors from generated files.
    ".next-lifecycle/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    // The container entrypoint Fly.io generates. Plain CommonJS on purpose - package.json
    // declares no module type, so `.js` IS CommonJS at runtime and its require() is
    // correct there. Linting it with the TypeScript config that eslint-config-next brings
    // applies @typescript-eslint/no-require-imports to a file where the rule is simply
    // wrong, which is what turned CI red on main at 1503a97 (green at c473fe3). It is a
    // deployment artefact, not application source, and nothing in src may import it.
    "docker-entrypoint.js",
  ]),
]);
