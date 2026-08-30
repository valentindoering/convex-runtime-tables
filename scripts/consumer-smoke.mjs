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
    CONVEX_AGENT_MODE: "anonymous",
    CONVEX_DISABLE_SENTRY: "1",
    NO_COLOR: "1",
  };
  const convexExecutable = join(consumer, "node_modules", ".bin", "convex");
  devProcess = await startConvex(convexExecutable, consumer, environment);
  const generated = join(consumer, "convex", "_generated");
  const before = await directoryDigest(generated);
  run(convexExecutable, ["codegen"], consumer, environment);
  const after = await directoryDigest(generated);
  if (before !== after)
    throw new Error(
      "Generated Convex files drifted after a second codegen run",
    );

  const envText = await readFile(join(consumer, ".env.local"), "utf8");
  const deploymentUrl = envText.match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]?.trim();
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
    const initialized = await writer.mutation(
      generatedApi.api.smoke.initialize,
      {},
    );
    const firstQuery = await subscriber.query(generatedApi.api.smoke.list, {
      tableId: initialized.tableId,
    });
    if (firstQuery.count !== 1)
      throw new Error(
        `Expected one packed-consumer row, got ${firstQuery.count}`,
      );

    const update = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Reactive subscription timed out")),
        15_000,
      );
      const unsubscribe = subscriber.onUpdate(
        generatedApi.api.smoke.list,
        { tableId: initialized.tableId },
        (value) => {
          if (value.count >= 2) {
            clearTimeout(timeout);
            unsubscribe();
            resolve(value);
          }
        },
      );
    });
    await writer.mutation(generatedApi.api.smoke.add, {
      tableId: initialized.tableId,
      key: "second",
      value: "from-another-client",
    });
    const reactive = await update;
    process.stdout.write(
      `${JSON.stringify({
        tarball: basename(tarball),
        mutation: "ok",
        queryCount: firstQuery.count,
        reactiveCount: reactive.count,
        codegenFresh: before === after,
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

async function startConvex(executable, cwd, env) {
  process.stdout.write(`$ ${executable} dev\n`);
  const child = spawn(executable, ["dev"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Convex dev startup timed out")),
      45_000,
    );
    const onData = (chunk) => {
      const output = chunk.toString();
      process.stdout.write(output);
      if (output.includes("Convex functions ready")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`Convex dev exited before readiness with status ${code}`),
      );
    });
  });
  return child;
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

const scopeId = "packed-consumer";

export const initialize = mutation({
  args: {},
  returns: v.object({ tableId: v.string() }),
  handler: async (ctx) => {
    const created = await ctx.runMutation(components.runtimeTables.public.createTable, {
      scopeId,
      slug: "items",
      name: "Items",
      fields: [
        { key: "key", name: "Key", type: "text", required: true },
        { key: "value", name: "Value", type: "text", required: true },
      ],
    });
    await ctx.runMutation(components.runtimeTables.public.insertRecords, {
      scopeId,
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
  args: { tableId: v.string(), key: v.string(), value: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const schema = await ctx.runQuery(components.runtimeTables.public.getTable, {
      scopeId,
      tableId: args.tableId,
    });
    const keyId = schema.fields.find((field) => field.key === "key")!._id;
    const valueId = schema.fields.find((field) => field.key === "value")!._id;
    const [written] = await ctx.runMutation(components.runtimeTables.public.insertRecords, {
      scopeId,
      tableId: args.tableId,
      records: [{ values: { [keyId]: args.key, [valueId]: args.value } }],
    });
    return written!.recordId;
  },
});

export const list = query({
  args: { tableId: v.string() },
  returns: v.object({ count: v.number(), values: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const result = await ctx.runQuery(components.runtimeTables.public.queryRecords, {
      scopeId,
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
