import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit" });
run("node", ["scripts/check-release.mjs"]);
run("node", ["scripts/prepare-release.mjs"]);
const manifest = JSON.parse(readFileSync(".release/manifest.json", "utf8"));
assert.equal(manifest.workingTreeChanges, "");
assert.equal(manifest.sourceCommit, process.env.CRT_RELEASE_REVIEW_SHA);
assert.equal(
  manifest.sha256,
  createHash("sha256").update(readFileSync(manifest.tarball)).digest("hex"),
);
run("npm", [
  "publish",
  manifest.tarball,
  "--access",
  "public",
  "--tag",
  "alpha",
  "--registry",
  "https://registry.npmjs.org/",
]);
