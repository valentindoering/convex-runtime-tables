import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { checkAlphaTags, initialAlpha } from "./alpha-tag-policy.mjs";

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
assert.ok(metadata, "Published package metadata must be readable");
const latestPolicy = checkAlphaTags(metadata, manifest.version);
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
if (manifest.version === initialAlpha.version) {
  assert.equal(
    sha256,
    initialAlpha.sha256,
    "First alpha must match its reviewed artifact",
  );
}
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
  inspectedSourceCommit: manifest.sourceCommit,
  publishedSourceCommit:
    manifest.version === initialAlpha.version
      ? initialAlpha.publishedCommit
      : (process.env.CRT_RELEASE_REVIEW_SHA ?? published.gitHead ?? null),
  distTags: metadata["dist-tags"],
  latestPolicy,
  integrity: published.dist.integrity,
  sha256,
  publishedAt: metadata.time[published.version],
};
await writeFile(
  ".release/verification.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
