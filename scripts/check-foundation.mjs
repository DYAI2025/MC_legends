import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const required = [
  "package.json",
  ".nvmrc",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "src/app/page.tsx",
  "src/app/welt/[id]/page.tsx",
  "src/app/components/idea-emblem.tsx",
  "src/content/content-source.ts",
  "src/content/avaloria-content.ts",
  "src/content/open-questions.ts",
  "src/app/child-submission-message.ts",
  "src/domain/submissions/submission.ts",
  "src/application/submissions/submission-repository.ts",
  "src/application/submissions/submission-inbox.ts",
  "src/application/submissions/submission-inbox-store.ts",
  "src/application/submissions/deliver-submission.ts",
  "src/application/access/family-access.ts",
  "src/application/access/family-session-client.ts",
  "src/application/access/rate-limiter.ts",
  "src/adapters/persistence/indexeddb-submission-repository.ts",
  "src/adapters/persistence/file-submission-inbox-store.ts",
  "src/adapters/persistence/inbox-record-shape.ts",
  "src/adapters/persistence/postgres-submission-inbox-store.ts",
  "src/adapters/http/http-submission-inbox.ts",
  "src/adapters/http/http-family-session-client.ts",
  "src/adapters/http/bounded-json-body.ts",
  "src/adapters/http/family-request-guard.ts",
  "src/adapters/http/family-session-cookie.ts",
  "src/adapters/access/hmac-family-access-gate.ts",
  "src/adapters/access/in-memory-rate-limiter.ts",
  "src/app/family-experience.tsx",
  "src/app/family-gate-message.ts",
  "src/app/components/family-access-gate.tsx",
  "src/adapters/media/audio-capture-controller.ts",
  "src/app/audio-capture-message.ts",
  "src/app/components/audio-answer-recorder.tsx",
  "src/composition/browser.ts",
  "src/composition/server.ts",
  "src/app/api/inbox/submissions/route.ts",
  "src/app/api/family/session/route.ts",
  "src/app/api/health/ready/route.ts",
  "src/domain/media/audio-artifact.ts",
  "src/application/media/audio-blob-store.ts",
  "src/adapters/persistence/file-audio-blob-store.ts",
  "src/app/api/inbox/submissions/audio/route.ts",
  "src/app/api/admin/inbox/submissions/[submissionId]/audio/route.ts",
  "db/migrations/0001_submission_inbox.sql",
  "db/migrations/0002_submission_audio.sql",
  "scripts/migrate.mjs",
  "scripts/import-inbox-jsonl.mjs",
  "scripts/check-secrets.mjs",
  "scripts/check-client-secrets.mjs",
  "scripts/check-integration-tests-ran.mjs",
  "scripts/backup-mc-legends.sh",
  "docs/deploy/vps-mc-legends.md",
  "docs/ops/MCL-48-backup-restore.md",
  "docs/ops/MCL-49-audio-storage.md",
  "docs/security/MCL-34-family-access.md",
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
