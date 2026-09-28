import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalRuntime,
  deriveRuntimeConfig,
  localDevArgs,
  parseWorktreePaths,
} from "./dev-config.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const convexExecutable = join(repository, "node_modules", ".bin", "convex");
const viteExecutable = join(repository, "node_modules", ".bin", "vite");
const runtimeEnvFile = join(repository, ".convex", "worktree.env.local");
const localConfigFile = join(
  repository,
  ".convex",
  "local",
  "default",
  "config.json",
);
const runtime = resolveRuntime();
const convexVersion = commandOutput(convexExecutable, ["--version"]);
assertLocalRuntime(runtime);
const review = tailnetReview("up", runtime.ports);
const environment = localEnvironment(runtime, review);
let stopping = false;
let backendReady = false;
let frontendReady = false;
let readinessPrinted = false;
let children = [];

try {
  await assertPortsAvailable(Object.values(runtime.ports));
  await writeRuntimeEnv(runtime, review);
  await ensureProjectLocalConfig();
  await writeRuntimeEnv(runtime, review);

  children = [
    start(
      "backend",
      convexExecutable,
      localDevArgs({
        version: convexVersion,
        envFile: runtimeEnvFile,
        ports: runtime.ports,
        start: "npm run dev:build",
      }),
    ),
    start("frontend", viteExecutable, [
      "example",
      "--host",
      "127.0.0.1",
      "--port",
      String(runtime.ports.vite),
      "--strictPort",
    ]),
  ];

  for (const child of children) {
    child.process.stdout.on("data", (chunk) => handleOutput(child, chunk));
    child.process.stderr.on("data", (chunk) => handleOutput(child, chunk));
    child.process.once("exit", (code, signal) => {
      if (stopping) return;
      process.stderr.write(
        `[${child.name}] exited unexpectedly (${signal ?? code ?? "unknown"})\n`,
      );
      void stopAll(code ?? 1);
    });
  }

  process.once("SIGINT", () => void stopAll(0));
  process.once("SIGTERM", () => void stopAll(0));
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(
    `Local development refused to start: ${message(error)}\n`,
  );
  await stopAll(1);
}

function resolveRuntime() {
  const commonGitDir = git([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const branch = git(["branch", "--show-current"]);
  const worktreePaths = parseWorktreePaths(
    git(["worktree", "list", "--porcelain"]),
  );
  return deriveRuntimeConfig({
    repository,
    commonGitDir,
    branch,
    worktreePaths,
  });
}

function git(args) {
  return commandOutput("git", args);
}

function commandOutput(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: repository,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${executable} ${args.join(" ")} failed`,
    );
  }
  return result.stdout.trim();
}

function tailnetReview(action, ports) {
  const args = [".codex/tailnet_review.py", action, "--root", repository, "--json"];
  if (ports) for (const [name, port] of Object.entries(ports))
    args.push("--service", `${name}=${port}`);
  const result = spawnSync("python3", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`Tailnet review unavailable: ${result.stderr.trim()}\n`);
    return {};
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    process.stderr.write("Tailnet review returned invalid JSON; using local URLs.\n");
    return {};
  }
}

function localEnvironment(config, review) {
  const env = { ...process.env };
  for (const key of [
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "CONVEX_OVERRIDE_ACCESS_TOKEN",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    CONVEX_AGENT_MODE: "anonymous",
    CONVEX_DISABLE_SENTRY: "1",
    CONVEX_DEPLOYMENT: config.deployment,
    CONVEX_URL: config.convexUrl,
    CONVEX_SITE_URL: config.siteUrl,
    VITE_CONVEX_URL: review.convex ?? config.convexUrl,
    VITE_CONVEX_SITE_URL: review.site ?? config.siteUrl,
    NO_COLOR: "1",
  };
}

async function writeRuntimeEnv(config, review) {
  assertLocalRuntime(config);
  await mkdir(dirname(runtimeEnvFile), { recursive: true });
  await writeFile(
    runtimeEnvFile,
    [
      `CONVEX_DEPLOYMENT=${config.deployment}`,
      `CONVEX_URL=${config.convexUrl}`,
      `CONVEX_SITE_URL=${config.siteUrl}`,
      `VITE_CONVEX_URL=${review.convex ?? config.convexUrl}`,
      `VITE_CONVEX_SITE_URL=${review.site ?? config.siteUrl}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function ensureProjectLocalConfig() {
  let config;
  try {
    config = JSON.parse(await readFile(localConfigFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    process.stdout.write(
      "[backend] bootstrapping isolated anonymous local state\n",
    );
    const bootstrap = spawnSync(
      convexExecutable,
      localDevArgs({
        version: convexVersion,
        envFile: runtimeEnvFile,
        ports: runtime.ports,
        once: true,
      }),
      { cwd: repository, env: environment, encoding: "utf8" },
    );
    if (bootstrap.stdout) process.stdout.write(bootstrap.stdout);
    if (bootstrap.stderr) process.stderr.write(bootstrap.stderr);
    if (bootstrap.status !== 0) {
      throw new Error(`local Convex bootstrap failed (${bootstrap.status})`);
    }
    config = JSON.parse(await readFile(localConfigFile, "utf8"));
  }

  if (typeof config.adminKey !== "string" || !config.adminKey.includes("|")) {
    throw new Error("local Convex config has no valid anonymous admin key");
  }
  const adminKeySuffix = config.adminKey.slice(
    config.adminKey.indexOf("|") + 1,
  );
  const localConfig = {
    ...config,
    ports: { cloud: runtime.ports.convex, site: runtime.ports.site },
    adminKey: `${runtime.instanceName}|${adminKeySuffix}`,
    deploymentName: runtime.instanceName,
  };
  delete localConfig.cloudProjectId;
  await writeFile(localConfigFile, `${JSON.stringify(localConfig)}\n`, {
    mode: 0o600,
  });
}

function start(name, executable, args) {
  return {
    name,
    process: spawn(executable, args, {
      cwd: repository,
      env: environment,
      stdio: ["inherit", "pipe", "pipe"],
    }),
  };
}

function handleOutput(child, chunk) {
  const output = chunk.toString();
  process.stdout.write(`[${child.name}] ${output}`);
  if (child.name === "backend" && output.includes("Convex functions ready")) {
    void verifyBackend();
  }
  if (child.name === "frontend" && output.includes("Local:")) {
    frontendReady = true;
    printReadiness();
  }
}

async function verifyBackend() {
  try {
    const response = await fetch(`${runtime.convexUrl}/instance_name`);
    if (!response.ok)
      throw new Error(`instance check returned HTTP ${response.status}`);
    const instanceName = await response.text();
    if (instanceName !== runtime.instanceName) {
      throw new Error(
        `backend identity ${JSON.stringify(instanceName)} does not match ${runtime.instanceName}`,
      );
    }
    backendReady = true;
    printReadiness();
  } catch (error) {
    process.stderr.write(
      `Local backend verification failed: ${message(error)}\n`,
    );
    await stopAll(1);
  }
}

function printReadiness() {
  if (!backendReady || !frontendReady || readinessPrinted) return;
  readinessPrinted = true;
  process.stdout.write(
    [
      `Local Convex target: ${runtime.convexUrl}`,
      `Local Convex instance: ${runtime.instanceName}`,
      `Showcase ready: ${runtime.showcaseUrl}`,
      ...(review.vite ? [`Tailnet showcase: ${review.vite}/`] : []),
      "",
    ].join("\n"),
  );
}

async function assertPortsAvailable(ports) {
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", () =>
        reject(new Error(`local port ${port} is already in use`)),
      );
      server.listen(port, "127.0.0.1", () => server.close(resolve));
    });
  }
}

async function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.process.exitCode !== null) return resolve();
          child.process.once("exit", resolve);
          setTimeout(() => {
            if (child.process.exitCode === null) child.process.kill("SIGKILL");
          }, 5_000).unref();
        }),
    ),
  );
  tailnetReview("down");
  process.exit(exitCode);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
