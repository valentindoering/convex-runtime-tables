import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const manifest = JSON.parse(await readFile(".release/manifest.json", "utf8"));
const registry = "https://registry.npmjs.org";
let metadata;
// npm publishes can take a few minutes to become publicly readable.
for (let attempt = 0; attempt < 24; attempt += 1) {
  const response = await fetch(`${registry}/${manifest.name}`, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) {
    metadata = await response.json();
    if (metadata["dist-tags"].alpha === manifest.version) break;
  } else {
    assert.equal(response.status, 404, "Registry metadata request failed");
  }
  await setTimeout(10_000);
}
assert.equal(metadata?.["dist-tags"].alpha, manifest.version);
assert.equal(
  metadata["dist-tags"].latest,
  undefined,
  "Alpha must not assign latest",
);
const published = metadata.versions[manifest.version];
assert.equal(published.name, manifest.name);
assert.equal(published.version, manifest.version);
assert.equal(published.dist.integrity, manifest.integrity);
assert.equal(
  published.dist.tarball,
  `${registry}/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`,
);
const response = await fetch(published.dist.tarball, {
  signal: AbortSignal.timeout(30_000),
});
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, manifest.sha256);
assert.equal(
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  published.dist.integrity,
);
assert.equal(
  createHash("sha1").update(bytes).digest("hex"),
  published.dist.shasum,
);
const result = {
  name: published.name,
  version: published.version,
  sourceCommit: manifest.sourceCommit,
  distTags: metadata["dist-tags"],
  integrity: published.dist.integrity,
  sha256,
  publishedAt: metadata.time[published.version],
};
await writeFile(
  ".release/verification.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
