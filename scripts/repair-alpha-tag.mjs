import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// This only removes latest when it points to the already published, inspected
// alpha. It never publishes, moves alpha, or removes a stable version's tag.
const manifest = JSON.parse(await readFile(".release/manifest.json", "utf8"));
assert.equal(manifest.name, "convex-runtime-tables");
assert.match(manifest.version, /^0\.1\.0-alpha\.[1-9]\d*$/);
const response = await fetch(
  "https://registry.npmjs.org/convex-runtime-tables",
  {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  },
);
assert.equal(response.status, 200);
const metadata = await response.json();
assert.equal(metadata["dist-tags"].alpha, manifest.version);
const published = metadata.versions[manifest.version];
assert.equal(published.dist.integrity, manifest.integrity);
assert.equal(
  published.dist.tarball,
  `https://registry.npmjs.org/convex-runtime-tables/-/convex-runtime-tables-${manifest.version}.tgz`,
);
const download = await fetch(published.dist.tarball, {
  signal: AbortSignal.timeout(30_000),
});
assert.equal(download.status, 200);
assert.equal(
  createHash("sha256")
    .update(Buffer.from(await download.arrayBuffer()))
    .digest("hex"),
  manifest.sha256,
);
if (metadata["dist-tags"].latest === undefined) {
  console.log("Published alpha has no latest tag");
} else {
  assert.equal(
    metadata["dist-tags"].latest,
    manifest.version,
    "Refuse to remove latest from any other version",
  );
  execFileSync(
    "npm",
    [
      "dist-tag",
      "rm",
      manifest.name,
      "latest",
      "--registry=https://registry.npmjs.org/",
    ],
    { stdio: "inherit" },
  );
}
