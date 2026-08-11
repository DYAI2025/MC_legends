import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return files.flat().filter((path) => /\.(ts|tsx)$/.test(path));
}

/** Accepts a directory to walk or a single source file named directly. */
async function sourceFilesAt(target: string): Promise<string[]> {
  return (await stat(target)).isDirectory() ? filesBelow(target) : [target];
}

async function expectNoForbiddenSource(
  target: string,
  forbidden: RegExp[],
  exclude: readonly string[] = [],
): Promise<void> {
  const files = (await sourceFilesAt(target)).filter((file) => !exclude.includes(file));

  // Without this, any regression in the walker turns every case below into a test
  // that checks nothing and still passes.
  expect(files.length, `${target} matched no source files to check`).toBeGreaterThan(0);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
    }
  }
}

describe("architecture boundaries", () => {
  it("keeps the domain independent from framework, application, and adapters", async () => {
    await expectNoForbiddenSource("src/domain", [
      /from ["']next(?:\/|["'])/,
      /from ["']react(?:\/|["'])/,
      /from ["']@\/application\//,
      /from ["']@\/adapters\//,
    ]);
  });

  it("keeps the application independent from Next.js and concrete adapters", async () => {
    await expectNoForbiddenSource("src/application", [
      /from ["']next(?:\/|["'])/,
      /from ["']@\/adapters\//,
    ]);
  });

  it("keeps the browser composition root out of the server composition root", async () => {
    await expectNoForbiddenSource("src/composition/browser.ts", [
      /from ["']@\/composition\/server["']/,
      /from ["']node:/,
    ]);
  });

  it("lets only the domain module name the server acknowledged status", async () => {
    // The bare literal, not an assignment shape: `{ status: ACK }` via a constant and
    // `{ ["status"]: "SERVER_ACKNOWLEDGED" }` both evade a `status:`-anchored pattern.
    await expectNoForbiddenSource(
      "src",
      [/SERVER_ACKNOWLEDGED/],
      ["src/domain/submissions/submission.ts"],
    );
  });

  it("keeps the content datasets independent from the delivery layer", async () => {
    await expectNoForbiddenSource("src/content", [
      /from ["']next(?:\/|["'])/,
      /from ["']react(?:\/|["'])/,
      /from ["']@\/adapters\//,
      /from ["']@\/app\//,
    ]);
  });
});
