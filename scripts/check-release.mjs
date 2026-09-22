import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();
const p = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(p.name, "convex-runtime-tables");
assert.match(p.version, /^0\.1\.0-alpha\.[1-9]\d*$/);
assert.equal(p.private, false);
assert.equal(p.publishConfig.access, "public");
assert.equal(p.publishConfig.tag, "alpha");
assert.equal(p.publishConfig.registry, "https://registry.npmjs.org/");
assert.equal(p.scripts.prepublishOnly, "node scripts/check-release.mjs");
assert.equal(p.scripts.alpha, "node scripts/publish-alpha.mjs");
assert.equal(p.scripts.release, "node scripts/publish-alpha.mjs");
if (!process.argv.includes("--config-only")) {
  const sha = run("git", ["rev-parse", "HEAD"]);
  assert.equal(
    process.env.CRT_RELEASE_REVIEW_SHA,
    sha,
    "A fresh release review must approve this exact commit",
  );
  assert.equal(
    run("git", ["status", "--porcelain"]),
    "",
    "Release checkout must be clean",
  );
  const repo = "valentindoering/convex-runtime-tables";
  const remote = JSON.parse(
    run("gh", ["repo", "view", repo, "--json", "visibility,defaultBranchRef"]),
  );
  assert.equal(
    remote.visibility,
    "PUBLIC",
    "Repository must be public before npm publication",
  );
  assert.equal(remote.defaultBranchRef.name, "main");
  const remoteSha = run("git", [
    "ls-remote",
    "https://github.com/valentindoering/convex-runtime-tables.git",
    "refs/heads/main",
  ]).split(/\s/)[0];
  assert.equal(remoteSha, sha, "Publish only the reviewed remote main commit");
  for (const workflow of ["ci.yml", "nightly.yml"]) {
    const runs = JSON.parse(
      run("gh", [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow,
        "--branch",
        "main",
        "--commit",
        sha,
        "--limit",
        "1",
        "--json",
        "headSha,status,conclusion,url",
      ]),
    );
    assert.equal(runs.length, 1, `Missing ${workflow} evidence`);
    assert.equal(runs[0].headSha, sha);
    assert.equal(runs[0].status, "completed", `${workflow} is unfinished`);
    assert.equal(runs[0].conclusion, "success", `${workflow} did not pass`);
    console.log(`${workflow}: ${runs[0].url}`);
  }
}
console.log("Alpha release configuration and requested gates passed");
