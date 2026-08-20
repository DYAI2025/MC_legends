/**
 * MCL-63. Asserts what the Cloudflare Worker bundle must and must not contain.
 *
 * Pins two failures, and the second is the one a green build would otherwise hide:
 *
 * 1. The historical one. `opennextjs-cloudflare build` failed with
 *    `Could not resolve "pg-cloudflare"` because Next traced `pg` into the server
 *    function. That failure is loud - the build exits non-zero on its own - so this
 *    script is not what catches it.
 * 2. The quiet one. Somebody removes the alias in next.config.ts, adds `pg` to
 *    `serverExternalPackages`, or marks `pg-cloudflare` external. The build then passes
 *    while a TCP PostgreSQL client sits inside the Worker, which is exactly the
 *    architecture MCL-48 forbids. Nothing else in the repository would notice.
 *
 * Measured 2026-08-20: with the alias removed, `npm run build:cloudflare` fails at
 * esbuild; with `pg` marked external instead, it succeeds and this script reports the
 * pg module directory it left behind.
 *
 * Refuses rather than passing on empty input, like the other check:* scripts.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const OUTPUT_DIR = ".open-next";
const WORKER_ENTRY = join(OUTPUT_DIR, "worker.js");
const ASSETS_DIR = join(OUTPUT_DIR, "assets");

/** The marker the fail-closed persistence stub carries. */
const STUB_MARKER = "MCL63_PERSISTENCE_UNAVAILABLE";

/** Text extensions worth scanning; the assets tree holds binaries we do not read. */
const SCANNED = /\.(m?js|cjs|json|txt|map)$/;

const failures = [];

function refuse(reason) {
  failures.push(reason);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return found.flat();
}

if (!(await exists(OUTPUT_DIR))) {
  console.error(
    `cloudflare-bundle: ${OUTPUT_DIR} is missing - run \`npm run build:cloudflare\` first`,
  );
  process.exit(1);
}

const allPaths = await walk(OUTPUT_DIR);

// Without this, every assertion below would pass vacuously on an empty output tree.
if (allPaths.length === 0) {
  console.error(`cloudflare-bundle: ${OUTPUT_DIR} is empty`);
  process.exit(1);
}

// 1. The two artefacts wrangler.jsonc points at.
if (!(await exists(WORKER_ENTRY))) {
  refuse(`${WORKER_ENTRY} is missing`);
} else if ((await stat(WORKER_ENTRY)).size === 0) {
  refuse(`${WORKER_ENTRY} is empty`);
}

const assetPaths = (await exists(ASSETS_DIR)) ? await walk(ASSETS_DIR) : [];
if (assetPaths.length === 0) {
  refuse(`${ASSETS_DIR} is missing or holds no files`);
}

// 2. No PostgreSQL client anywhere in the worker output.
const pgModuleDirs = allPaths.filter((path) =>
  /(^|\/)node_modules\/(pg|pg-cloudflare|pg-pool|pg-protocol)\//.test(path),
);
if (pgModuleDirs.length > 0) {
  refuse(
    `${pgModuleDirs.length} PostgreSQL client file(s) present, first: ${pgModuleDirs[0]}`,
  );
}

// 3. Neither the bundled code nor the traced tree mentions the package that failed.
const scannable = allPaths.filter((path) => SCANNED.test(path));
if (scannable.length === 0) {
  refuse("no scannable files in the worker output");
}

const pgCloudflareHits = [];
let stubMarkerHits = 0;

for (const path of scannable) {
  const source = await readFile(path, "utf8");
  if (source.includes("pg-cloudflare")) {
    pgCloudflareHits.push(path);
  }
  if (source.includes(STUB_MARKER)) {
    stubMarkerHits += 1;
  }
}

if (pgCloudflareHits.length > 0) {
  refuse(
    `pg-cloudflare referenced in ${pgCloudflareHits.length} file(s), first: ${pgCloudflareHits[0]}`,
  );
}

// 4. The fail-closed stub really replaced the adapters. Without this, a build that
//    dropped `pg` for some unrelated reason would look identical to a working alias.
if (stubMarkerHits === 0) {
  refuse(
    `${STUB_MARKER} not found in the worker output - the persistence alias did not apply`,
  );
}

// 5. No build-time secret reached the bundle. Same approach as check-client-secrets.mjs:
//    refuse when nothing is set, so the scan cannot pass by having nothing to look for.
const SECRET_NAMES = [
  "AVALORIA_FAMILY_ACCESS_CODE",
  "AVALORIA_SESSION_SECRET",
  "AVALORIA_ADMIN_ACCESS_CODE",
];
const secrets = SECRET_NAMES.map((name) => [name, process.env[name]?.trim() ?? ""]).filter(
  ([, value]) => value.length > 0,
);

if (secrets.length === 0) {
  console.error(
    `cloudflare-bundle: set ${SECRET_NAMES.join(", ")} to the values used for the build`,
  );
  process.exit(1);
}

for (const [name, value] of secrets) {
  if (value.length < 8) {
    console.error(`cloudflare-bundle: ${name} is too short to scan for meaningfully`);
    process.exit(1);
  }
}

for (const path of scannable) {
  const source = await readFile(path, "utf8");
  for (const [name, value] of secrets) {
    if (source.includes(value)) {
      // The name, never the value.
      refuse(`${name} reached the worker output in ${path}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`cloudflare-bundle: ${failure}`);
  }
  process.exit(1);
}

console.log(
  `cloudflare-bundle: ok (${allPaths.length} files, ${assetPaths.length} assets, ${stubMarkerHits} stub marker hit(s), ${secrets.length} secret(s) scanned)`,
);
