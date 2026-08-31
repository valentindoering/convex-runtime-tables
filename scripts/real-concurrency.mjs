import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
let left;
let right;
let shuttingDown = false;

try {
  runBuild();
  devProcess = await startConvex();
  const envText = await readFile(
    new URL("../.env.local", import.meta.url),
    "utf8",
  );
  const deploymentUrl = envText.match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]?.trim();
  if (!deploymentUrl) throw new Error("VITE_CONVEX_URL was not generated");
  const { ConvexClient } = await import("convex/browser");
  const { api } = await import(
    `${pathToFileURL(new URL("../example/convex/_generated/api.js", import.meta.url).pathname).href}?concurrency=${Date.now()}`
  );
  left = new ConvexClient(deploymentUrl);
  right = new ConvexClient(deploymentUrl);
  const runId = Date.now().toString(36);
  const fixture = {
    ...(await left.mutation(api.concurrency.initialize, { runId })),
    runId,
  };
  await waitForJob(api, runId, fixture.jobId);
  const writeFixture = {
    runId,
    tableId: fixture.tableId,
    keyId: fixture.keyId,
    valueId: fixture.valueId,
  };

  for (let run = 0; run < 20; run += 1) {
    const race = {
      ...(await left.mutation(api.concurrency.initializeDeleteBackfillRace, {
        runId,
        iteration: run,
      })),
      runId,
    };
    const build = await left.mutation(api.concurrency.startDeleteBackfillRace, {
      runId,
      iteration: run,
      tableId: race.tableId,
      keyId: race.keyId,
    });
    await right.mutation(api.concurrency.deleteOne, {
      runId,
      tableId: race.tableId,
      recordId: race.deleteRecordId,
    });
    await waitForJob(api, runId, build.jobId);
    const oracle = await assertOracle(api, { ...race, indexId: build.indexId });
    assert(oracle.recordCount === 204, `R1 stored ${oracle.recordCount} rows`);
    const cleanup = await left.mutation(api.concurrency.deleteTable, {
      runId,
      tableId: race.tableId,
    });
    await waitForJob(api, runId, cleanup.jobId);
  }

  for (let run = 0; run < 20; run += 1) {
    const args = {
      ...writeFixture,
      key: `r7-${run}`,
    };
    const results = await Promise.allSettled([
      left.mutation(api.concurrency.insertOne, { ...args, value: "left" }),
      right.mutation(api.concurrency.insertOne, { ...args, value: "right" }),
    ]);
    assertSettled(results, 1, 1, "R7");
    assertErrorCode(results, "UNIQUE_CONFLICT", "R7");
    await assertOracle(api, fixture);
  }

  for (let run = 0; run < 20; run += 1) {
    const request = {
      ...writeFixture,
      start: 10_000 + run * 2,
      count: 2,
      idempotencyKey: `r8-${run}`,
      payloadTag: "same",
    };
    const [leftIds, rightIds] = await Promise.all([
      left.mutation(api.concurrency.insertBatch, request),
      right.mutation(api.concurrency.insertBatch, request),
    ]);
    assert(
      JSON.stringify(leftIds) === JSON.stringify(rightIds),
      "R8 returned different IDs",
    );
    await expectCode(
      () =>
        right.mutation(api.concurrency.insertBatch, {
          ...request,
          payloadTag: "different",
        }),
      "IDEMPOTENCY_MISMATCH",
      "R8",
    );
    await assertOracle(api, fixture);
  }

  for (let run = 0; run < 20; run += 1) {
    const record = await left.mutation(api.concurrency.insertOne, {
      ...writeFixture,
      key: `r9-${run}`,
      value: "initial",
    });
    const request = {
      runId,
      tableId: fixture.tableId,
      valueId: fixture.valueId,
      recordId: record.recordId,
      expectedRev: 1,
    };
    const results = await Promise.allSettled([
      left.mutation(api.concurrency.patchOne, { ...request, value: "left" }),
      right.mutation(api.concurrency.patchOne, { ...request, value: "right" }),
    ]);
    assertSettled(results, 1, 1, "R9");
    const failure = results.find(
      (result) => result.status === "rejected",
    ).reason;
    const data = errorData(failure);
    assert(data?.code === "CONFLICT", `R9 returned ${JSON.stringify(data)}`);
    assert(
      JSON.stringify(data).length <= 512,
      "R9 conflict payload is unbounded",
    );
    const detailKeys = Object.keys(data.details ?? {}).sort();
    assert(
      JSON.stringify(detailKeys) === JSON.stringify(["currentRev", "recordId"]),
      `R9 conflict details are not bounded: ${JSON.stringify(detailKeys)}`,
    );
    await assertOracle(api, fixture);
  }

  const batchStarts = Array.from(
    { length: 50 },
    (_, index) => 20_000 + index * 100,
  );
  for (let offset = 0; offset < batchStarts.length; offset += 8) {
    await Promise.all(
      batchStarts.slice(offset, offset + 8).map(async (start) => {
        const request = {
          ...writeFixture,
          start,
          count: 100,
          idempotencyKey: `l3-${start}`,
          payloadTag: "l3",
        };
        const [leftIds, rightIds] = await Promise.all([
          left.mutation(api.concurrency.insertBatch, request),
          right.mutation(api.concurrency.insertBatch, request),
        ]);
        assert(
          JSON.stringify(leftIds) === JSON.stringify(rightIds),
          `L3 returned different IDs for ${start}`,
        );
      }),
    );
  }
  const oracle = await assertOracle(api, fixture);
  assert(
    oracle.recordCount === 5_080,
    `L3 expected 5080 records, got ${oracle.recordCount}`,
  );
  process.stdout.write(
    `REAL_CONCURRENCY ${JSON.stringify({ R1: 20, R7: 20, R8: 20, R9: 20, L3Rows: 5000, ...oracle })}\n`,
  );
} finally {
  if (left) await left.close();
  if (right) await right.close();
  if (devProcess && devProcess.exitCode === null) {
    shuttingDown = true;
    devProcess.kill("SIGTERM");
    await new Promise((resolve) => devProcess.once("exit", resolve));
  }
}

async function assertOracle(api, fixture) {
  const records = [];
  let cursor;
  do {
    const page = await left.query(api.concurrency.page, {
      runId: fixture.runId,
      tableId: fixture.tableId,
      cursor,
    });
    records.push(...page.records);
    cursor = page.continueCursor ?? undefined;
  } while (cursor);
  const entries = [];
  cursor = undefined;
  do {
    const page = await right.query(api.concurrency.auditEntries, {
      runId: fixture.runId,
      indexId: fixture.indexId,
      cursor,
    });
    entries.push(...page.entries);
    cursor = page.continueCursor ?? undefined;
  } while (cursor);
  const byRecord = new Map();
  for (const entry of entries) {
    assert(
      !byRecord.has(entry.recordId),
      `Oracle found duplicate entry ${entry.recordId}`,
    );
    byRecord.set(entry.recordId, entry);
  }
  for (const record of records) {
    const entry = byRecord.get(record.recordId);
    assert(entry, `Oracle found missing entry ${record.recordId}`);
    assert(
      entry.recordRev === record.rev,
      `Oracle found stale revision ${record.recordId}`,
    );
    assert(
      entry.k0 === String(record.values[fixture.keyId]).normalize("NFC") &&
        entry.k1 === null &&
        entry.k2 === null,
      `Oracle found stale key ${record.recordId}`,
    );
  }
  assert(entries.length === records.length, "Oracle found orphaned entries");
  return { recordCount: records.length, entryCount: entries.length };
}

function assertSettled(results, fulfilled, rejected, label) {
  assert(
    results.filter((result) => result.status === "fulfilled").length ===
      fulfilled &&
      results.filter((result) => result.status === "rejected").length ===
        rejected,
    `${label} had an unexpected outcome: ${JSON.stringify(results)}`,
  );
}

function assertErrorCode(results, code, label) {
  const failure = results.find((result) => result.status === "rejected");
  assert(
    errorData(failure?.reason)?.code === code,
    `${label} did not return ${code}`,
  );
}

async function expectCode(operation, code, label) {
  try {
    await operation();
  } catch (error) {
    assert(
      errorData(error)?.code === code,
      `${label} returned ${JSON.stringify(errorData(error))}`,
    );
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

function errorData(error) {
  return error && typeof error === "object" && "data" in error
    ? error.data
    : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForJob(api, runId, jobId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await left.query(api.concurrency.getJob, {
      runId,
      jobId,
    });
    if (state === "succeeded") return;
    if (state === "failed" || state === "superseded") {
      throw new Error(`Index setup ended in ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Index setup timed out");
}

function runBuild() {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0)
    throw new Error(`Build failed with status ${result.status}`);
}

async function startConvex() {
  const executable = join(repository, "node_modules", ".bin", "convex");
  const child = spawn(executable, ["dev"], {
    cwd: repository,
    env: environment,
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
