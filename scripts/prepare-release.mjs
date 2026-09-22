import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Build a reviewable candidate without enabling or performing publication.
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, ".release");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.name, "convex-runtime-tables");
assert.match(manifest.version, /^0\.1\.0-alpha\.[1-9]\d*$/);
assert.equal(manifest.scripts.prepublishOnly, "node scripts/check-release.mjs");
await mkdir(destination, { recursive: true });

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
  return result.stdout;
}

run("npm", ["run", "build"]);
const [packed] = JSON.parse(
  run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    true,
  ),
);
const files = new Set(packed.files.map(({ path }) => path));
function checkExports(value) {
  if (typeof value === "string") {
    assert(files.has(value.replace(/^\.\//, "")), `Missing export: ${value}`);
  } else {
    for (const entry of Object.values(value)) checkExports(entry);
  }
}
checkExports(manifest.exports);
for (const required of [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "docs/host-integration.md",
  "docs/query-contract.md",
])
  assert(files.has(required), `Missing documentation: ${required}`);
for (const path of files) {
  assert(
    !/(^|\/)(\.env[^/]*|\.convex|node_modules|example|scripts)(\/|$)/.test(
      path,
    ),
    `Unexpected private/development file: ${path}`,
  );
  assert(
    !/\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/.test(path),
    `Test file in package: ${path}`,
  );
}
const tarball = join(destination, packed.filename);
const report = {
  name: packed.name,
  version: packed.version,
  intendedTag: "alpha",
  published: false,
  publicationRequiresGates: true,
  sourceCommit: run("git", ["rev-parse", "HEAD"], true).trim(),
  workingTreeChanges: run("git", ["status", "--porcelain"], true).trim(),
  tarball,
  sha256: createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex"),
  integrity: packed.integrity,
  size: packed.size,
  unpackedSize: packed.unpackedSize,
  files: [...files].sort(),
};
await writeFile(
  join(destination, "manifest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify({ ...report, files: report.files.length }, null, 2));
