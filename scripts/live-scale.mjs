import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repository = new URL("../", import.meta.url).pathname;
const environment = {
  ...process.env,
  CONVEX_AGENT_MODE: "anonymous",
  CONVEX_DISABLE_SENTRY: "1",
  NO_COLOR: "1",
};
let devProcess;
let client;
let applicationRetries = 0;
let shuttingDown = false;
let currentRunId;

try {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
  });
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.status !== 0)
    throw new Error(`Build failed with status ${build.status}`);
  devProcess = await startConvex(repository, environment);
  const envText = await readFile(
    new URL("../.env.local", import.meta.url),
    "utf8",
  );
  const deploymentUrl = envText.match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]?.trim();
  if (!deploymentUrl) throw new Error("VITE_CONVEX_URL was not generated");
  const { ConvexClient } = await import("convex/browser");
  const { api } = await import(
    `${pathToFileURL(new URL("../example/convex/_generated/api.js", import.meta.url).pathname).href}?scale=${Date.now()}`
  );
  client = new ConvexClient(deploymentUrl);

  const startedAt = performance.now();
  const runId = Date.now().toString(36);
  process.stdout.write(`SCALE_PROGRESS runId=${runId}\n`);
  currentRunId = runId;
  const initialized = await client.mutation(api.scale.initialize, { runId });
  const fixture = { ...initialized, runId };
  const retainedIds = [];
  await insertRange(api, fixture, 0, 50_000, retainedIds);
  process.stdout.write("SCALE_PROGRESS imported=50000\n");

  const seqBuild = await client.mutation(api.scale.createIndex, {
    runId,
    tableId: fixture.tableId,
    name: "bySeq",
    fieldIds: [fixture.seqId],
  });
  const groupBuild = await client.mutation(api.scale.createIndex, {
    runId,
    tableId: fixture.tableId,
    name: "byGroupSeq",
    fieldIds: [fixture.groupId, fixture.seqId],
  });

  await Promise.all([
    insertRange(api, fixture, 50_000, 50_000, retainedIds),
    mutateDuringBuild(api, fixture, retainedIds),
  ]);
  process.stdout.write(
    "SCALE_PROGRESS imported=100000 concurrent_writes=done\n",
  );
  const buildJobs = await Promise.all([
    waitForJob(api, seqBuild.jobId),
    waitForJob(api, groupBuild.jobId),
  ]);
  for (const job of buildJobs) {
    if (job.state !== "succeeded")
      throw new Error(`Index build failed: ${JSON.stringify(job)}`);
  }
  process.stdout.write("SCALE_PROGRESS builds=done\n");

  const verifyStarts = await Promise.all([
    client.mutation(api.scale.verifyIndex, {
      runId,
      indexId: seqBuild.indexId,
    }),
    client.mutation(api.scale.verifyIndex, {
      runId,
      indexId: groupBuild.indexId,
    }),
  ]);
  const verifyJobs = await Promise.all(
    verifyStarts.map((job) => waitForJob(api, job.jobId)),
  );
  for (const job of verifyJobs) {
    if (job.state !== "succeeded" || job.verificationMismatchCount !== 0) {
      throw new Error(`Read-only oracle failed: ${JSON.stringify(job)}`);
    }
  }
  process.stdout.write("SCALE_PROGRESS oracle=exact\n");

  const asc = await traverse(api, fixture, seqBuild.indexId, "asc");
  const desc = await traverse(api, fixture, seqBuild.indexId, "desc");
  const reversed = [...asc.ids].reverse();
  if (JSON.stringify(desc.ids) !== JSON.stringify(reversed)) {
    throw new Error(
      "Ascending and descending traversals are not exact reverses",
    );
  }
  if (new Set(asc.ids).size !== asc.ids.length) {
    throw new Error("Pagination produced duplicate record IDs");
  }

  const metrics = {
    recordCount: asc.ids.length,
    wallTimeMs: Math.round(performance.now() - startedAt),
    pageLatencyMs: {
      p50: percentile(asc.latencies, 0.5),
      p95: percentile(asc.latencies, 0.95),
      first: asc.latencies[0],
      deep: asc.latencies[Math.floor(asc.latencies.length / 2)],
    },
    readsPerPage: {
      documentsP50: percentile(asc.documentsRead, 0.5),
      documentsP95: percentile(asc.documentsRead, 0.95),
      bytesP50: percentile(asc.bytesRead, 0.5),
      bytesP95: percentile(asc.bytesRead, 0.95),
      firstDocuments: asc.documentsRead[0],
      deepDocuments:
        asc.documentsRead[Math.floor(asc.documentsRead.length / 2)],
    },
    buildJobs,
    verifyJobs,
    applicationOccRetryCount: applicationRetries,
    storageAmplification: {
      indexEntriesPerRecord: 2,
      totalIndexEntries: asc.ids.length * 2,
      note: "Exact byte storage requires a deployment export; the gate reports exact document amplification.",
    },
    failures: 0,
  };
  process.stdout.write(`SCALE_METRICS ${JSON.stringify(metrics)}\n`);
} finally {
  if (client) await client.close();
  if (devProcess && devProcess.exitCode === null) {
    shuttingDown = true;
    devProcess.kill("SIGTERM");
    await new Promise((resolve) => devProcess.once("exit", resolve));
  }
}

async function insertRange(api, fixture, start, count, retainedIds) {
  const starts = Array.from(
    { length: count / 100 },
    (_, index) => start + index * 100,
  );
  for (let offset = 0; offset < starts.length; offset += 8) {
    const group = starts.slice(offset, offset + 8);
    const results = await Promise.all(
      group.map((batchStart) =>
        withRetries(() =>
          client.mutation(api.scale.insertBatch, {
            ...fixture,
            start: batchStart,
            count: 100,
          }),
        ),
      ),
    );
    if (retainedIds.length < 100)
      retainedIds.push(...results.flat().slice(0, 100));
    if ((offset + group.length) % 100 === 0) {
      process.stdout.write(
        `SCALE_PROGRESS imported=${start + (offset + group.length) * 100}\n`,
      );
    }
  }
}

async function mutateDuringBuild(api, fixture, ids) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await Promise.all(
    ids.slice(0, 20).map((recordId, index) =>
      index < 10
        ? withRetries(() =>
            client.mutation(api.scale.patchOne, {
              runId: fixture.runId,
              tableId: fixture.tableId,
              recordId,
              payloadId: fixture.payloadId,
              expectedRev: 1,
              value: `patched-during-build-${index}`,
            }),
          )
        : withRetries(() =>
            client.mutation(api.scale.deleteOne, {
              runId: fixture.runId,
              tableId: fixture.tableId,
              recordId,
            }),
          ),
    ),
  );
}

async function waitForJob(api, jobId) {
  const deadline = Date.now() + 60 * 60_000;
  let lastJob = null;
  while (Date.now() < deadline) {
    const job = await client.query(api.scale.getJob, {
      runId: currentRunId,
      jobId,
    });
    lastJob = job;
    if (job && ["succeeded", "failed", "superseded"].includes(job.state))
      return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Job timed out: ${jobId}; last state: ${JSON.stringify(lastJob)}`,
  );
}

async function traverse(api, fixture, indexId, direction) {
  const ids = [];
  const latencies = [];
  const bytesRead = [];
  const documentsRead = [];
  let cursor;
  do {
    const started = performance.now();
    const page = await client.query(api.scale.page, {
      runId: fixture.runId,
      tableId: fixture.tableId,
      indexId,
      orderFieldId: fixture.seqId,
      direction,
      cursor,
    });
    latencies.push(Number((performance.now() - started).toFixed(3)));
    bytesRead.push(page.bytesRead);
    documentsRead.push(page.documentsRead);
    ids.push(...page.ids);
    cursor = page.continueCursor ?? undefined;
    if (latencies.length % 100 === 0) {
      process.stdout.write(
        `SCALE_PROGRESS traversal=${direction} pages=${latencies.length}\n`,
      );
    }
  } while (cursor);
  return { ids, latencies, bytesRead, documentsRead };
}

async function withRetries(operation) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!String(error).includes("OCC") || attempt === 4) throw error;
      applicationRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))
  ];
}

async function startConvex(cwd, env) {
  const executable = join(cwd, "node_modules", ".bin", "convex");
  process.stdout.write(`$ ${executable} dev\n`);
  const child = spawn(executable, ["dev"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Convex dev startup timed out")),
      60_000,
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
  child.once("exit", (code) => {
    if (!shuttingDown) {
      process.stderr.write(
        `Convex dev exited unexpectedly with status ${code}\n`,
      );
      process.exit(1);
    }
  });
  return child;
}
