import { readFile, readdir } from "node:fs/promises";
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

async function expectNoForbiddenImports(directory: string, forbidden: RegExp[]): Promise<void> {
  for (const file of await filesBelow(directory)) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
    }
  }
}

describe("architecture boundaries", () => {
  it("keeps the domain independent from framework, application, and adapters", async () => {
    await expectNoForbiddenImports("src/domain", [
      /from ["']next(?:\/|["'])/,
      /from ["']react(?:\/|["'])/,
      /from ["']@\/application\//,
      /from ["']@\/adapters\//,
    ]);
  });

  it("keeps the application independent from Next.js and concrete adapters", async () => {
    await expectNoForbiddenImports("src/application", [
      /from ["']next(?:\/|["'])/,
      /from ["']@\/adapters\//,
    ]);
  });
});
