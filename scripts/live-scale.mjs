import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repository = new URL("../", import.meta.url).pathname;
const JOB_TIMEOUT_MS = 150 * 60_000;
const TOTAL_ROWS = Number(process.env.SCALE_ROW_COUNT ?? 100_000);
if (
  !Number.isInteger(TOTAL_ROWS) ||
  TOTAL_ROWS < 200 ||
  TOTAL_ROWS % 200 !== 0
) {
  throw new Error("SCALE_ROW_COUNT must be a positive multiple of 200");
}
const INITIAL_ROWS = TOTAL_ROWS / 2;
const hostedGate =
  process.env.CONVEX_HOSTED_GATE === "1" ||
  Boolean(process.env.CONVEX_DEPLOY_KEY);
const environment = {
  ...process.env,
  CONVEX_DISABLE_SENTRY: "1",
  NO_COLOR: "1",
  ...(hostedGate ? {} : { CONVEX_AGENT_MODE: "anonymous" }),
};
let devProcess;
let client;
let applicationRetries = 0;
let shuttingDown = false;
let currentRunId;
let fixture;
let generatedApi;
let cleanedUp = false;

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
  devProcess = await startConvex(repository, environment, hostedGate);
  const deploymentUrl =
    process.env.CONVEX_TEST_URL ??
    (await readFile(new URL("../.env.local", import.meta.url), "utf8"))
      .match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]
      ?.trim();
  if (!deploymentUrl) throw new Error("VITE_CONVEX_URL was not generated");
  const { ConvexClient } = await import("convex/browser");
  const { api } = await import(
    `${pathToFileURL(new URL("../example/convex/_generated/api.js", import.meta.url).pathname).href}?scale=${Date.now()}`
  );
  generatedApi = api;
  client = new ConvexClient(deploymentUrl);

  const startedAt = performance.now();
  const runId = Date.now().toString(36);
  process.stdout.write(`SCALE_PROGRESS runId=${runId}\n`);
  currentRunId = runId;
  const initialized = await client.mutation(api.scale.initialize, { runId });
  fixture = { ...initialized, runId };
  const retainedIds = [];
  await insertRange(api, fixture, 0, INITIAL_ROWS, retainedIds);
  process.stdout.write(`SCALE_PROGRESS imported=${INITIAL_ROWS}\n`);

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
    insertRange(
      api,
      fixture,
      INITIAL_ROWS,
      TOTAL_ROWS - INITIAL_ROWS,
      retainedIds,
    ),
    mutateDuringBuild(api, fixture, retainedIds),
  ]);
  process.stdout.write(
    `SCALE_PROGRESS imported=${TOTAL_ROWS} concurrent_writes=done\n`,
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

  const records = await readAllRecords(api, fixture);
  assertExpectedRecords(records, fixture);
  const [seqEntries, groupEntries] = await Promise.all([
    readAllEntries(api, fixture, seqBuild.indexId, "bySeq"),
    readAllEntries(api, fixture, groupBuild.indexId, "byGroupSeq"),
  ]);
  assertOracle(records, seqEntries, [fixture.seqId], "bySeq");
  assertOracle(
    records,
    groupEntries,
    [fixture.groupId, fixture.seqId],
    "byGroupSeq",
  );
  process.stdout.write("SCALE_PROGRESS independent_oracle=exact\n");

  const [seqAsc, seqDesc, groupAsc, groupDesc] = await Promise.all([
    traverse(api, fixture, seqBuild.indexId, [fixture.seqId], "asc", "bySeq"),
    traverse(api, fixture, seqBuild.indexId, [fixture.seqId], "desc", "bySeq"),
    traverse(
      api,
      fixture,
      groupBuild.indexId,
      [fixture.groupId, fixture.seqId],
      "asc",
      "byGroupSeq",
    ),
    traverse(
      api,
      fixture,
      groupBuild.indexId,
      [fixture.groupId, fixture.seqId],
      "desc",
      "byGroupSeq",
    ),
  ]);
  assertTraversal(records, seqAsc, seqDesc, [fixture.seqId], "bySeq");
  assertTraversal(
    records,
    groupAsc,
    groupDesc,
    [fixture.groupId, fixture.seqId],
    "byGroupSeq",
  );

  const cleanupJob = await client.mutation(api.scale.deleteTable, {
    runId,
    tableId: fixture.tableId,
  });
  const cleanup = await waitForJob(api, cleanupJob.jobId);
  if (cleanup.state !== "succeeded") {
    throw new Error(`Scale cleanup failed: ${JSON.stringify(cleanup)}`);
  }
  const remainingTables = await client.query(api.scale.tableCount, { runId });
  if (remainingTables !== 0) {
    throw new Error(`Scale cleanup left ${remainingTables} table(s)`);
  }
  cleanedUp = true;
  process.stdout.write("SCALE_PROGRESS cleanup=exact\n");

  const metrics = {
    recordCount: records.length,
    wallTimeMs: Math.round(performance.now() - startedAt),
    pageLatencyMs: {
      p50: percentile(seqAsc.latencies, 0.5),
      p95: percentile(seqAsc.latencies, 0.95),
      first: seqAsc.latencies[0],
      deep: seqAsc.latencies[Math.floor(seqAsc.latencies.length / 2)],
    },
    readsPerPage: {
      documentsP50: percentile(seqAsc.documentsRead, 0.5),
      documentsP95: percentile(seqAsc.documentsRead, 0.95),
      bytesP50: percentile(seqAsc.bytesRead, 0.5),
      bytesP95: percentile(seqAsc.bytesRead, 0.95),
      firstDocuments: seqAsc.documentsRead[0],
      deepDocuments:
        seqAsc.documentsRead[Math.floor(seqAsc.documentsRead.length / 2)],
    },
    buildJobs,
    independentOracle: {
      recordCount: records.length,
      bySeqEntryCount: seqEntries.length,
      byGroupSeqEntryCount: groupEntries.length,
    },
    applicationOccRetryCount: applicationRetries,
    storageAmplification: {
      indexEntriesPerRecord: 2,
      totalIndexEntries: seqEntries.length + groupEntries.length,
      note: "Exact byte storage requires a deployment export; the gate reports exact document amplification.",
    },
    failures: 0,
    cleanup: { job: cleanup, remainingTables },
  };
  process.stdout.write(`SCALE_METRICS ${JSON.stringify(metrics)}\n`);
} finally {
  if (client && generatedApi && fixture && !cleanedUp) {
    try {
      const cleanupJob = await client.mutation(generatedApi.scale.deleteTable, {
        runId: fixture.runId,
        tableId: fixture.tableId,
      });
      await waitForJob(generatedApi, cleanupJob.jobId);
      process.stderr.write("SCALE_PROGRESS cleanup=best-effort\n");
    } catch (error) {
      process.stderr.write(`SCALE_CLEANUP_FAILED ${String(error)}\n`);
    }
  }
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
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let nextProgressAt = Date.now() + 60_000;
  let lastJob = null;
  while (Date.now() < deadline) {
    const job = await client.query(api.scale.getJob, {
      runId: currentRunId,
      jobId,
    });
    lastJob = job;
    if (job && ["succeeded", "failed", "superseded"].includes(job.state))
      return job;
    if (Date.now() >= nextProgressAt) {
      process.stdout.write(
        `SCALE_PROGRESS job=${jobId} state=${job?.state ?? "missing"} progress=${job?.progress ?? 0} batches=${job?.batchCount ?? 0} retries=${job?.retryCount ?? 0}\n`,
      );
      nextProgressAt = Date.now() + 60_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Job timed out: ${jobId}; last state: ${JSON.stringify(lastJob)}`,
  );
}

async function traverse(
  api,
  fixture,
  indexId,
  orderFieldIds,
  direction,
  label,
) {
  const ids = [];
  const records = [];
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
      orderFieldIds,
      direction,
      cursor,
    });
    if (page.planIndexId !== indexId) {
      throw new Error(
        `${label} ${direction} selected ${page.planIndexId} instead of ${indexId}`,
      );
    }
    latencies.push(Number((performance.now() - started).toFixed(3)));
    bytesRead.push(page.bytesRead);
    documentsRead.push(page.documentsRead);
    ids.push(...page.ids);
    records.push(
      ...page.ids.map((recordId, index) => ({
        recordId,
        rev: page.revs[index],
        values: page.values[index],
      })),
    );
    cursor = page.continueCursor ?? undefined;
    if (latencies.length % 100 === 0) {
      process.stdout.write(
        `SCALE_PROGRESS traversal=${label}:${direction} pages=${latencies.length}\n`,
      );
    }
  } while (cursor);
  return { ids, records, latencies, bytesRead, documentsRead };
}

async function readAllRecords(api, fixture) {
  const records = [];
  let cursor;
  do {
    const result = await client.query(api.scale.recordsPage, {
      runId: fixture.runId,
      tableId: fixture.tableId,
      cursor,
    });
    records.push(...result.page);
    cursor = result.continueCursor ?? undefined;
    if (records.length % 10_000 === 0) {
      process.stdout.write(`SCALE_PROGRESS oracle_records=${records.length}\n`);
    }
  } while (cursor);
  return records;
}

async function readAllEntries(api, fixture, indexId, label) {
  const entries = [];
  let cursor;
  do {
    const result = await client.query(api.scale.auditEntries, {
      runId: fixture.runId,
      indexId,
      cursor,
    });
    entries.push(...result.page);
    cursor = result.continueCursor ?? undefined;
    if (entries.length % 10_000 === 0) {
      process.stdout.write(
        `SCALE_PROGRESS oracle_entries=${label}:${entries.length}\n`,
      );
    }
  } while (cursor);
  return entries;
}

function assertOracle(records, entries, fieldIds, label) {
  const recordsById = new Map(
    records.map((record) => [record.recordId, record]),
  );
  const entriesById = new Map();
  for (const entry of entries) {
    if (entriesById.has(entry.recordId)) {
      throw new Error(
        `${label} oracle found duplicate entry for ${entry.recordId}`,
      );
    }
    entriesById.set(entry.recordId, entry);
  }
  const mismatches = [];
  for (const record of records) {
    const entry = entriesById.get(record.recordId);
    if (!entry) {
      mismatches.push(`missing:${record.recordId}`);
      continue;
    }
    const slots = fieldIds.map((fieldId) =>
      normalize(record.values[fieldId] ?? null),
    );
    while (slots.length < 3) slots.push(null);
    if (
      entry.recordRev !== record.rev ||
      !Object.is(entry.k0, slots[0]) ||
      !Object.is(entry.k1, slots[1]) ||
      !Object.is(entry.k2, slots[2])
    ) {
      mismatches.push(`stale:${record.recordId}`);
    }
  }
  for (const entry of entries) {
    if (!recordsById.has(entry.recordId))
      mismatches.push(`orphan:${entry.recordId}`);
  }
  if (mismatches.length > 0 || entries.length !== records.length) {
    throw new Error(
      `${label} independent oracle mismatch count=${mismatches.length} samples=${JSON.stringify(mismatches.slice(0, 10))}`,
    );
  }
}

function assertExpectedRecords(records, fixture) {
  if (records.length !== TOTAL_ROWS - 10) {
    throw new Error(
      `Expected ${TOTAL_ROWS - 10} surviving records, got ${records.length}`,
    );
  }
  const bySequence = new Map();
  for (const record of records) {
    const sequence = record.values[fixture.seqId];
    if (!Number.isInteger(sequence) || bySequence.has(sequence)) {
      throw new Error(`Invalid or duplicate sequence ${String(sequence)}`);
    }
    bySequence.set(sequence, record);
  }
  for (let sequence = 0; sequence < TOTAL_ROWS; sequence += 1) {
    const record = bySequence.get(sequence);
    if (sequence >= 10 && sequence < 20) {
      if (record) throw new Error(`Deleted sequence ${sequence} survived`);
      continue;
    }
    if (!record) throw new Error(`Expected sequence ${sequence} is missing`);
    const expectedPayload =
      sequence < 10
        ? `patched-during-build-${sequence}`
        : `payload-${sequence}-${"x".repeat(40)}`;
    if (
      record.values[fixture.groupId] !== `group-${sequence % 100}` ||
      record.values[fixture.payloadId] !== expectedPayload ||
      record.rev !== (sequence < 10 ? 2 : 1)
    ) {
      throw new Error(`Sequence ${sequence} has an unexpected final value`);
    }
  }
}

function assertTraversal(records, asc, desc, fieldIds, label) {
  const recordsById = new Map(
    records.map((record) => [record.recordId, record]),
  );
  const expected = [...records].sort((left, right) =>
    compareRecord(left, right, fieldIds),
  );
  const expectedIds = expected.map((record) => record.recordId);
  if (new Set(asc.ids).size !== asc.ids.length) {
    throw new Error(`${label} ascending traversal contains duplicate IDs`);
  }
  if (JSON.stringify(asc.ids) !== JSON.stringify(expectedIds)) {
    throw new Error(
      `${label} ascending traversal differs from independent order`,
    );
  }
  if (JSON.stringify(desc.ids) !== JSON.stringify([...expectedIds].reverse())) {
    throw new Error(`${label} descending traversal is not the exact reverse`);
  }
  for (const traversed of asc.records) {
    const expectedRecord = recordsById.get(traversed.recordId);
    if (
      !expectedRecord ||
      traversed.rev !== expectedRecord.rev ||
      JSON.stringify(traversed.values) !== JSON.stringify(expectedRecord.values)
    ) {
      throw new Error(
        `${label} traversal hydrated a stale value for ${traversed.recordId}`,
      );
    }
  }
}

function compareRecord(left, right, fieldIds) {
  for (const fieldId of fieldIds) {
    const comparison = compareScalar(
      normalize(left.values[fieldId] ?? null),
      normalize(right.values[fieldId] ?? null),
    );
    if (comparison !== 0) return comparison;
  }
  return left.recordId < right.recordId
    ? -1
    : left.recordId > right.recordId
      ? 1
      : 0;
}

function compareScalar(left, right) {
  const rank = (value) =>
    value === null
      ? 0
      : typeof value === "boolean"
        ? 1
        : typeof value === "number"
          ? 2
          : 3;
  const difference = rank(left) - rank(right);
  if (difference !== 0) return difference;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalize(value) {
  return typeof value === "string" ? value.normalize("NFC") : value;
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

async function startConvex(cwd, env, hosted) {
  const executable = join(cwd, "node_modules", ".bin", "convex");
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
      60_000,
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
  if (hosted) return undefined;
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
