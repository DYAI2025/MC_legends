import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const required = [
  "package.json",
  ".nvmrc",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "src/app/page.tsx",
  "src/content/content-source.ts",
  "src/content/avaloria-content.ts",
  "src/content/open-questions.ts",
  "src/app/child-submission-message.ts",
  "src/domain/submissions/submission.ts",
  "src/application/submissions/submission-repository.ts",
  "src/application/submissions/submission-inbox.ts",
  "src/application/submissions/submission-inbox-store.ts",
  "src/application/submissions/deliver-submission.ts",
  "src/adapters/persistence/indexeddb-submission-repository.ts",
  "src/adapters/persistence/file-submission-inbox-store.ts",
  "src/adapters/http/http-submission-inbox.ts",
  "src/composition/server.ts",
  "src/app/api/inbox/submissions/route.ts",
  "scripts/check-secrets.mjs",
  "docs/architecture/ADR-0001-web-foundation.md",
  "docs/architecture/project-intake.json",
  "docs/architecture/architecture-decision.json",
  "docs/architecture/stack-adapter.json",
  "docs/architecture/build-manifest.json"
];

for (const path of required) {
  await readFile(path, "utf8");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

const textFiles = (await walk(".")).filter((path) => !path.includes("/.git/") && !path.includes("node_modules"));
const forbidden = [/Hogwarts Legacy/i, /Harry Potter/i];
for (const path of textFiles) {
  if (!/\.(md|json|ts|tsx|mjs|css|yml|yaml|txt)$/.test(path)) continue;
  const content = await readFile(path, "utf8");
  if (path.includes("tests/e2e") || path.includes("AGENTS.md") || path.includes("docs/architecture") || path.endsWith("scripts/check-foundation.mjs")) continue;
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      throw new Error(`Forbidden franchise reference in runtime/source file: ${path}`);
    }
  }
}

console.log("foundation-structure: ok");
