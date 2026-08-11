import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const ignoredDirectories = new Set([".git", ".next", ".validation", "node_modules", "coverage", "playwright-report", "test-results"]);
const textExtensions = new Set([".md", ".json", ".ts", ".tsx", ".mjs", ".js", ".css", ".yml", ".yaml", ".txt"]);

const rules = [
  { name: "private-key-block", pattern: new RegExp(["-----BEGIN ", "PRIVATE KEY-----"].join("")) },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", pattern: new RegExp(["gh", "[pousr]_[A-Za-z0-9]{20,}"].join("")) },
  { name: "google-api-key", pattern: new RegExp(["AIza", "[A-Za-z0-9_-]{30,}"].join("")) },
  { name: "slack-token", pattern: new RegExp(["xox", "[aboprs]-[A-Za-z0-9-]{10,}"].join("")) },
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path)));
    else output.push(path);
  }

  return output;
}

for (const path of await walk(".")) {
  if (path.endsWith("scripts/check-secrets.mjs")) continue;
  if (!textExtensions.has(extname(path)) && !path.endsWith(".npmrc") && !path.endsWith(".nvmrc") && !path.endsWith(".gitignore")) continue;

  const content = await readFile(path, "utf8");
  for (const rule of rules) {
    if (rule.pattern.test(content)) {
      throw new Error(`Potential secret (${rule.name}) in ${path}`);
    }
  }
}

console.log("secret-scan: ok");
