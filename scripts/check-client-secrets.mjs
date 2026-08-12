import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Proves that the family access secrets did not reach anything a browser downloads.
 *
 * Run AFTER `next build`, with the same secret values the build was given. Both halves
 * matter: a scan with no secret configured would pass by having nothing to look for,
 * and a scan of a missing build directory would pass by having nothing to look at.
 * Both are refused below, so this check cannot report a vacuous success.
 *
 * The architecture test forbids naming these variables outside the server composition
 * root, which is the check that catches the mistake in source. This one catches it in
 * the artifact that actually ships.
 */

const BUILD_DIRECTORY = ".next";
const CLIENT_DIRECTORIES = [join(BUILD_DIRECTORY, "static"), join(BUILD_DIRECTORY, "server")];

/** Only what a browser can receive: bundles, source maps, prerendered documents. */
const SCANNED_EXTENSIONS = [".js", ".mjs", ".cjs", ".css", ".map", ".html", ".rsc", ".json", ".txt"];

const MINIMUM_SECRET_LENGTH = 8;

const secrets = [
  ["AVALORIA_FAMILY_ACCESS_CODE", process.env.AVALORIA_FAMILY_ACCESS_CODE],
  ["AVALORIA_SESSION_SECRET", process.env.AVALORIA_SESSION_SECRET],
].filter(([, value]) => typeof value === "string" && value.trim().length > 0);

if (secrets.length === 0) {
  throw new Error(
    "client-bundle scan needs AVALORIA_FAMILY_ACCESS_CODE (and optionally AVALORIA_SESSION_SECRET) " +
      "set to the values the build was given. With nothing to search for, this check would pass without proving anything.",
  );
}

for (const [name, value] of secrets) {
  if (value.trim().length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `${name} is shorter than ${MINIMUM_SECRET_LENGTH} characters. A short value matches by accident and makes this scan meaningless.`,
    );
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return nested.flat();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(BUILD_DIRECTORY))) {
  throw new Error(`${BUILD_DIRECTORY} does not exist - run "npm run build" before this check.`);
}

const files = [];
for (const directory of CLIENT_DIRECTORIES) {
  if (await exists(directory)) {
    files.push(...(await walk(directory)));
  }
}

const scanned = files.filter((path) => SCANNED_EXTENSIONS.some((suffix) => path.endsWith(suffix)));

if (scanned.length === 0) {
  throw new Error(
    `No build output found under ${CLIENT_DIRECTORIES.join(", ")}. A scan of nothing is not a pass.`,
  );
}

for (const path of scanned) {
  const content = await readFile(path, "utf8");

  for (const [name, value] of secrets) {
    if (content.includes(value.trim())) {
      throw new Error(`${name} leaked into build output: ${path}`);
    }
  }

  // The prefix Next.js inlines into browser code. Nothing in this project may use it
  // for an access value, so its appearance next to one of these names is a finding
  // even if the value itself is absent from this particular file.
  if (/NEXT_PUBLIC_[A-Z0-9_]*(ACCESS|SECRET|TOKEN|PASSWORD|CREDENTIAL)/.test(content)) {
    throw new Error(`Publicly inlined access variable in build output: ${path}`);
  }
}

console.log(
  `client-bundle-secret-scan: ok (${scanned.length} files, ${secrets.map(([name]) => name).join(", ")})`,
);
