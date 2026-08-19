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

  it("points the browser admin sign-in at the admin endpoint, not the family one", async () => {
    // The endpoint string is the entire difference between the two sign-in factories, and
    // it is not reachable from a unit test without a live fetch - so nothing else in the
    // suite notices if it changes. Measured: re-pointing the admin factory at
    // /api/family/session leaves the whole suite green and tsc silent, while making the
    // admin panel authenticate against the children's gate. That is the one separation
    // the fail-closed gate in the previous commit exists to protect, so it is asserted at
    // the level where the mistake is visible: the source.
    const source = await readFile("src/composition/browser.ts", "utf8");

    expect(source).toContain("/api/admin/session");
    // And never names the family endpoint: HttpFamilySessionClient defaults to it, so the
    // only way that string appears here is a factory pointed at the wrong gate.
    expect(source).not.toContain("/api/family/session");
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

  it("names the family access secrets only in the server composition root", async () => {
    // The variables themselves, not just a leaked value: a component that reads
    // process.env.AVALORIA_FAMILY_ACCESS_CODE is how the code reaches the bundle in
    // the first place, and it is a change to source that must fail here, not a build
    // artifact somebody has to remember to scan.
    await expectNoForbiddenSource(
      "src",
      [
        /AVALORIA_FAMILY_ACCESS_CODE/,
        /AVALORIA_SESSION_SECRET/,
        // MCL-50's admin code, held to the same rule from the day it exists. A second
        // secret is a second chance for a component to read one directly and drag it
        // into the client bundle, and the rule is worth nothing if it only covers the
        // secrets somebody remembered to add.
        /AVALORIA_ADMIN_ACCESS_CODE/,
      ],
      ["src/composition/server.ts"],
    );
  });

  it("exposes nothing to the client bundle through a NEXT_PUBLIC_ variable", async () => {
    // No exclusions on purpose. NEXT_PUBLIC_ is the one prefix Next.js inlines into
    // browser code, so there is no file in src where introducing one is routine.
    await expectNoForbiddenSource("src", [/NEXT_PUBLIC_/]);
  });

  it("keeps the server composition root and node APIs out of the client components", async () => {
    for (const clientComponent of [
      "src/app/family-experience.tsx",
      "src/app/components/family-access-gate.tsx",
      // MCL-50. Added with the components themselves: this list is hardcoded, so a
      // client component missing from it is one the rule silently does not cover.
      "src/app/components/admin-access-gate.tsx",
      "src/app/components/admin-inbox-view.tsx",
      // MCL-30A. Reaches for microphone and object URLs, so it is exactly the kind of
      // component that would otherwise be tempted to import a server module for them.
      "src/app/components/audio-answer-recorder.tsx",
    ]) {
      await expectNoForbiddenSource(clientComponent, [
        /from ["']@\/composition\/server["']/,
        /from ["']node:/,
      ]);
    }
  });

  it("keeps the content datasets independent from the delivery layer", async () => {
    await expectNoForbiddenSource("src/content", [
      /from ["']next(?:\/|["'])/,
      /from ["']react(?:\/|["'])/,
      /from ["']@\/adapters\//,
      /from ["']@\/app\//,
    ]);
  });

  it("never lets a test replace the process environment object", async () => {
    // Measured, not theoretical: `vi.stubEnv` and `vi.unstubAllEnvs` write through a
    // Proxy whose target is the `process.env` captured when vitest loaded, and that
    // proxy has no deleteProperty trap. Its get/set traps forward to the *current*
    // process.env, but an unset - `stubEnv(name, undefined)`, and the delete branch of
    // `unstubAllEnvs` - deletes from the target. Once a test assigns to `process.env`,
    // target and current object are two different objects, so every later unset
    // silently stops unsetting while reads and writes keep working. A fail-closed case
    // then passes alone and grants in a shared-process run.
    //
    // Today only vitest's fork-per-file isolation hides that - a runner setting, not
    // test hygiene. Measured on this repo with `isolate: false` and a single fork: 7
    // failures across 2 files, of which 6 were MCL-50's own admin-inbox cases. Once
    // inbox-route's afterEach had replaced process.env, health-ready-route's unreachable
    // DATABASE_URL could no longer be unstubbed, so the admin read reached for
    // PostgreSQL at 127.0.0.1:1 instead of the file store and answered 503.
    //
    // A source rule rather than a runtime assertion, because the damage is done in an
    // afterEach whose own file has already finished asserting.
    await expectNoForbiddenSource("tests", [/^\s*process\.env\s*=[^=]/mu]);
  });
});
