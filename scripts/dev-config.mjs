import { createHash } from "node:crypto";
import { resolve } from "node:path";

const FIRST_PORT = 20_000;
const PORT_BLOCKS = 10_000;

export function parseWorktreePaths(output) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)))
    .sort();
}

export function deriveRuntimeConfig({
  repository,
  commonGitDir,
  branch,
  worktreePaths,
}) {
  const worktree = resolve(repository);
  const paths = [...new Set(worktreePaths.map((path) => resolve(path)))].sort();
  if (!paths.includes(worktree)) {
    throw new Error(
      `Current worktree is missing from git worktree list: ${worktree}`,
    );
  }

  const claimedBlocks = new Map();
  for (const path of paths) {
    let block = hashNumber(`${resolve(commonGitDir)}\0${path}`) % PORT_BLOCKS;
    while (claimedBlocks.has(block)) block = (block + 1) % PORT_BLOCKS;
    claimedBlocks.set(block, path);
  }
  const selectedBlock = [...claimedBlocks.entries()].find(
    ([, path]) => path === worktree,
  )?.[0];
  if (selectedBlock === undefined) throw new Error("Unable to allocate ports");

  const convexPort = FIRST_PORT + selectedBlock * 3;
  const identityHash = createHash("sha256")
    .update(worktree)
    .digest("hex")
    .slice(0, 10);
  const branchSlug = slug(branch || "detached").slice(0, 28);
  const instanceName = `anonymous-runtime-tables-${branchSlug}-${identityHash}`;
  const convexUrl = `http://127.0.0.1:${convexPort}`;
  const siteUrl = `http://127.0.0.1:${convexPort + 1}`;
  const showcaseUrl = `http://127.0.0.1:${convexPort + 2}/`;
  const deployment = `anonymous:${instanceName}`;

  const runtime = {
    deployment,
    instanceName,
    convexUrl,
    siteUrl,
    showcaseUrl,
    ports: {
      convex: convexPort,
      site: convexPort + 1,
      vite: convexPort + 2,
    },
  };
  assertLocalRuntime(runtime);
  return runtime;
}

export function assertLocalRuntime(runtime) {
  if (!runtime.deployment.startsWith("anonymous:")) {
    throw new Error(`Refusing non-anonymous deployment: ${runtime.deployment}`);
  }
  if (runtime.deployment !== `anonymous:${runtime.instanceName}`) {
    throw new Error(
      "Deployment selector does not match the local instance name",
    );
  }
  for (const [label, value] of [
    ["Convex", runtime.convexUrl],
    ["Convex site", runtime.siteUrl],
    ["showcase", runtime.showcaseUrl],
  ]) {
    assertLoopbackUrl(label, value);
  }
}

export function assertLoopbackUrl(label, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid: ${value}`);
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(`Refusing non-loopback ${label} URL: ${value}`);
  }
}

export function localDevArgs({ version, envFile, ports, once, start }) {
  const args = ["dev"];
  if (supportsExplicitLocalFlag(version)) args.push("--local");
  args.push(
    "--env-file",
    envFile,
    "--local-cloud-port",
    String(ports.convex),
    "--local-site-port",
    String(ports.site),
  );
  if (once) args.push("--once");
  if (start) args.push("--start", start);
  return args;
}

export function supportsExplicitLocalFlag(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Unable to parse Convex CLI version: ${version}`);
  const [, major, minor] = match.map(Number);
  return major < 1 || (major === 1 && minor < 41);
}

function hashNumber(value) {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "detached"
  );
}
