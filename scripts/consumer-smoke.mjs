import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repository = new URL("../", import.meta.url).pathname;
const temporary = await mkdtemp(
  join(tmpdir(), "convex-runtime-tables-consumer-"),
);
const consumer = join(temporary, "consumer");
const packDirectory = join(temporary, "pack");
const hostedGate =
  process.env.CONVEX_HOSTED_GATE === "1" ||
  Boolean(process.env.CONVEX_DEPLOY_KEY);
const smokeScopeId = "packed-consumer";
let succeeded = false;
let devProcess;
const baseEnvironment = {
  ...process.env,
  npm_config_cache: join(temporary, "npm-cache"),
  npm_config_registry: "https://registry.npmjs.org/",
};

try {
  await mkdir(consumer, { recursive: true });
  await mkdir(packDirectory, { recursive: true });
  run(
    "npm",
    ["pack", "--pack-destination", packDirectory],
    repository,
    baseEnvironment,
  );
  const tarballName = (await readdir(packDirectory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!tarballName) throw new Error("npm pack did not produce a tarball");
  const tarball = join(packDirectory, tarballName);
  await assertProductionTarball(tarball, temporary);

  await writeConsumerFiles(consumer);
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      tarball,
      "convex@1.45.0",
      "vite@8.2.0",
      "typescript@6.0.2",
    ],
    consumer,
    baseEnvironment,
  );

  const environment = {
    ...baseEnvironment,
    CONVEX_DISABLE_SENTRY: "1",
    NO_COLOR: "1",
    ...(hostedGate ? {} : { CONVEX_AGENT_MODE: "anonymous" }),
  };
  const convexExecutable = join(consumer, "node_modules", ".bin", "convex");
  devProcess = await startConvex(
    convexExecutable,
    consumer,
    environment,
    hostedGate,
  );
  const generated = join(consumer, "convex", "_generated");
  const before = await directoryDigest(generated);
  run(convexExecutable, ["codegen"], consumer, environment);
  const after = await directoryDigest(generated);
  if (before !== after)
    throw new Error(
      "Generated Convex files drifted after a second codegen run",
    );

  const deploymentUrl =
    process.env.CONVEX_TEST_URL ??
    (await readFile(join(consumer, ".env.local"), "utf8"))
      .match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]
      ?.trim();
  if (!deploymentUrl) throw new Error("VITE_CONVEX_URL was not generated");
  const convexBrowser = await import(
    pathToFileURL(
      join(
        consumer,
        "node_modules",
        "convex",
        "dist",
        "esm",
        "browser",
        "index.js",
      ),
    ).href
  );
  const generatedApi = await import(
    pathToFileURL(join(generated, "api.js")).href
  );
  const writer = new convexBrowser.ConvexClient(deploymentUrl);
  const subscriber = new convexBrowser.ConvexClient(deploymentUrl);
  try {
    await purgeSmokeScope(writer, generatedApi.api.smoke, smokeScopeId);
    const smokeRuns = [];
    for (let run = 1; run <= 2; run += 1) {
      smokeRuns.push(
        await runSmokeFixture(
          writer,
          subscriber,
          generatedApi.api.smoke,
          smokeScopeId,
        ),
      );
    }
    const lastRun = smokeRuns.at(-1);
    process.stdout.write(
      `${JSON.stringify({
        tarball: basename(tarball),
        mutation: "ok",
        queryCount: lastRun.queryCount,
        reactiveCount: lastRun.reactiveCount,
        codegenFresh: before === after,
        runs: smokeRuns.length,
        preflight: "succeeded",
        cleanup: smokeRuns.every((run) => run.cleanup === "succeeded")
          ? "succeeded"
          : "failed",
      })}\n`,
    );
  } finally {
    await writer.close();
    await subscriber.close();
  }
  succeeded = true;
} finally {
  await stopProcess(devProcess);
  if (succeeded) await rm(temporary, { recursive: true, force: true });
  else process.stderr.write(`Consumer workspace retained at ${temporary}\n`);
}

async function runSmokeFixture(writer, subscriber, api, scopeId) {
  let tableId;
  let result;
  let primaryError;
  let updateTimeout;
  let unsubscribe;
  const closeSubscription = () => {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = undefined;
    if (unsubscribe) unsubscribe();
    unsubscribe = undefined;
  };
  try {
    const initialized = await writer.mutation(api.initialize, { scopeId });
    tableId = initialized.tableId;
    const firstQuery = await subscriber.query(api.list, { scopeId, tableId });
    if (firstQuery.count !== 1)
      throw new Error(
        `Expected one packed-consumer row, got ${firstQuery.count}`,
      );

    const update = new Promise((resolve, reject) => {
      updateTimeout = setTimeout(
        () => reject(new Error("Reactive subscription timed out")),
        15_000,
      );
      unsubscribe = subscriber.onUpdate(
        api.list,
        { scopeId, tableId },
        (value) => {
          if (value.count >= 2) {
            closeSubscription();
            resolve(value);
          }
        },
      );
    });
    await writer.mutation(api.add, {
      scopeId,
      tableId,
      key: "second",
      value: "from-another-client",
    });
    const reactive = await update;
    result = {
      queryCount: firstQuery.count,
      reactiveCount: reactive.count,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    closeSubscription();
  }

  let cleanupError;
  if (tableId) {
    try {
      await cleanupSmokeFixture(writer, api, scopeId, tableId);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError) {
    if (cleanupError)
      process.stderr.write(
        `Best-effort consumer cleanup also failed: ${errorMessage(cleanupError)}\n`,
      );
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  if (!result || !tableId)
    throw new Error("Packed consumer did not initialize its fixture");
  return { ...result, cleanup: "succeeded" };
}

async function cleanupSmokeFixture(writer, api, scopeId, tableId) {
  await deleteSmokeTable(writer, api, scopeId, tableId);
  await assertSmokeScopeEmpty(writer, api, scopeId);
}

async function purgeSmokeScope(writer, api, scopeId) {
  while (true) {
    const tableIds = await writer.query(api.listTables, { scopeId });
    if (tableIds.length === 0) return;
    for (const tableId of tableIds) {
      await deleteSmokeTable(writer, api, scopeId, tableId);
    }
  }
}

async function deleteSmokeTable(writer, api, scopeId, tableId) {
  const deletion = await writer.mutation(api.deleteTable, { scopeId, tableId });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await writer.query(api.getJob, {
      scopeId,
      jobId: deletion.jobId,
    });
    if (!job) throw new Error("Consumer cleanup job disappeared");
    if (job.state === "succeeded") return;
    if (job.state === "failed" || job.state === "superseded")
      throw new Error(`Consumer cleanup job ended as ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Consumer cleanup job timed out");
}

async function assertSmokeScopeEmpty(writer, api, scopeId) {
  const tableIds = await writer.query(api.listTables, { scopeId });
  if (tableIds.length !== 0)
    throw new Error(
      `Consumer cleanup left ${tableIds.length} table(s) in scope ${scopeId}`,
    );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function startConvex(executable, cwd, env, hosted) {
  const args = hosted ? ["dev", "--once"] : ["dev"];
  process.stdout.write(`$ ${executable} ${args.join(" ")}\n`);
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Convex dev startup timed out")),
      120_000,
    );
    const onData = (chunk) => {
      const output = chunk.toString();
      process.stdout.write(output);
      if (!hosted && output.includes("Convex functions ready")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (hosted && code === 0) resolve();
      else
        reject(
          new Error(`Convex dev exited before readiness with status ${code}`),
        );
    });
  });
  return hosted ? undefined : child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const terminated = waitForExit(child, 5_000);
  child.kill("SIGTERM");
  if (await terminated) return;
  const killed = waitForExit(child, 5_000);
  child.kill("SIGKILL");
  if (!(await killed)) throw new Error("Convex dev process did not stop");
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) finish(true);
  });
}

function run(command, args, cwd, env = process.env) {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

async function writeConsumerFiles(directory) {
  await mkdir(join(directory, "convex"), { recursive: true });
  await mkdir(join(directory, "src"), { recursive: true });
  const files = {
    "package.json": JSON.stringify(
      {
        name: "runtime-tables-packed-consumer",
        private: true,
        type: "module",
        scripts: { build: "vite build" },
        dependencies: {},
      },
      null,
      2,
    ),
    "index.html":
      '<main id="app">packed consumer</main>\n<script type="module" src="/src/main.ts"></script>\n',
    "src/main.ts":
      'document.querySelector("#app")!.textContent = "runtime tables consumer";\n',
    "convex/convex.config.ts": `import { defineApp } from "convex/server";
import runtimeTables from "convex-runtime-tables/convex.config.js";
const app = defineApp();
app.use(runtimeTables);
export default app;
`,
    "convex/smoke.ts": `import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const jobStateValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("superseded"),
);

export const initialize = mutation({
  args: { scopeId: v.string() },
  returns: v.object({ tableId: v.string() }),
  handler: async (ctx, args) => {
    const created = await ctx.runMutation(components.runtimeTables.public.createTable, {
      scopeId: args.scopeId,
      slug: "items",
      name: "Items",
      fields: [
        { key: "key", name: "Key", type: "text", required: true },
        { key: "value", name: "Value", type: "text", required: true },
      ],
    });
    await ctx.runMutation(components.runtimeTables.public.insertRecords, {
      scopeId: args.scopeId,
      tableId: created.table._id,
      records: [{ values: {
        [created.fields[0]!._id]: "first",
        [created.fields[1]!._id]: "from-packed-tarball",
      } }],
    });
    return { tableId: created.table._id };
  },
});

export const add = mutation({
  args: {
    scopeId: v.string(),
    tableId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(components.runtimeTables.public.getTable, {
      scopeId: args.scopeId,
      tableId: args.tableId,
    });
    const keyId = schema.fields.find((field) => field.key === "key")!._id;
    const valueId = schema.fields.find((field) => field.key === "value")!._id;
    const [written] = await ctx.runMutation(components.runtimeTables.public.insertRecords, {
      scopeId: args.scopeId,
      tableId: args.tableId,
      records: [{ values: { [keyId]: args.key, [valueId]: args.value } }],
    });
    return written!.recordId;
  },
});

export const list = query({
  args: { scopeId: v.string(), tableId: v.string() },
  returns: v.object({ count: v.number(), values: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(components.runtimeTables.public.queryRecords, {
      scopeId: args.scopeId,
      tableId: args.tableId,
      query: { where: [] },
      pagination: { pageSize: 100 },
    });
    return {
      count: result.page.length,
      values: result.page.map((record) => JSON.stringify(record.values)),
    };
  },
});

export const deleteTable = mutation({
  args: { scopeId: v.string(), tableId: v.string() },
  returns: v.object({ jobId: v.string() }),
  handler: async (ctx, args) => {
    return await ctx.runMutation(components.runtimeTables.public.deleteTable, {
      scopeId: args.scopeId,
      tableId: args.tableId,
    });
  },
});

export const getJob = query({
  args: { scopeId: v.string(), jobId: v.string() },
  returns: v.union(v.null(), v.object({ state: jobStateValidator })),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(components.runtimeTables.public.getJob, {
      scopeId: args.scopeId,
      jobId: args.jobId,
    });
    return job ? { state: job.state } : null;
  },
});

export const listTables = query({
  args: { scopeId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const tables = await ctx.runQuery(components.runtimeTables.public.listTables, {
      scopeId: args.scopeId,
      pagination: { pageSize: 100 },
    });
    return tables.page.map((table) => table._id);
  },
});
`,
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
  }
}

async function directoryDigest(directory) {
  const hash = createHash("sha256");
  for (const name of (await readdir(directory)).sort()) {
    hash.update(name);
    hash.update(await readFile(join(directory, name)));
  }
  return hash.digest("hex");
}

async function assertProductionTarball(tarball, temporary) {
  const unpacked = join(temporary, "unpacked");
  await mkdir(unpacked, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", unpacked], repository, baseEnvironment);
  const files = await recursiveFiles(unpacked);
  const forbiddenFile = files.find(
    (file) => file.includes(".test.") || /\/testing\.[^.]+$/.test(file),
  );
  if (forbiddenFile) {
    throw new Error(
      `Packed tarball contains a test-only module: ${forbiddenFile}`,
    );
  }
  for (const file of files) {
    const content = await readFile(file);
    const text = content.toString("utf8");
    if (
      text.includes("patchRecordWithoutIndexMaintenance") ||
      text.includes("insertOrphanedIndexEntry") ||
      text.includes("faults.test")
    ) {
      throw new Error(`Packed tarball exposes a fault-injection hook: ${file}`);
    }
  }
}

async function recursiveFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await recursiveFiles(path)));
    else result.push(path);
  }
  return result;
}
