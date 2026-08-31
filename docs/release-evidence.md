# Release evidence

Status: publication remains blocked. The deterministic local gates are green.
The required 100,000-row cloud-development gate has not run against this
revision, so this document does not claim release readiness.

## Local deterministic gates

- `npm test`: 87 tests across 8 files passed with no type errors.
- `npm run test:coverage`: 87 tests passed in 46.91 seconds. Overall coverage is
  87.81% statements, 73.54% branches, 93.19% functions, and 90.18% lines.
  Critical-file branch coverage is planner 65.23%, index data 81.81%, and
  lifecycle jobs 79.20%.
- `npm run test:real-concurrency`: an anonymous local Convex backend passed 20
  two-client repetitions each for delete versus backfill, unique insertion,
  idempotent insertion, and expected-revision patching. The final 5,000-row
  concurrent idempotent import reported 5,080 records and 5,080 exact sidecar
  entries after including the preceding race fixtures.
- `npm run test:consumer`: the exact tarball installed into a clean consumer,
  mounted the component, code-generated twice without drift, executed a mutation
  and query, and delivered a `ConvexClient.onUpdate` callback from a second
  client. The result was `mutation=ok`, `queryCount=1`, `reactiveCount=2`, and
  `codegenFresh=true`. The tarball contained 104 files and was 103.3 kB
  compressed / 645.9 kB unpacked. Its inspected contents had no test module or
  fault-injection hook.
- `SCALE_ROW_COUNT=1000 npm run test:scale`: the revised harness passed its
  exact known-survivor assertion, two independent raw-sidecar oracles, both
  indexes in both directions, selected-index checks on every page, and table
  purge with zero remaining tables. It completed in 2,782 ms with 990 expected
  survivors and 1,980 sidecar entries.
- `npm run format`, `npm run lint`, `npm run typecheck`, and `npm run build`
  passed locally.

Expected conflict logs from the real-concurrency gate are part of its oracle:
each losing request must report `UNIQUE_CONFLICT`, `IDEMPOTENCY_MISMATCH`, or a
bounded `CONFLICT` while the paired request succeeds.

## Development setup

`npm run dev` starts the anonymous local Convex backend, the component build
watcher, and Vite. The combined command was checked at
`http://127.0.0.1:50090/version` and `http://127.0.0.1:5173/`; both returned
HTTP 200, and Ctrl-C stopped both processes. Local development does not upload
code or data.

## Cloud gate status

The earlier GitHub run `33326349821` used the anonymous local backend on a
GitHub runner. Its 100,000-row step took 2 hours 11 minutes 56 seconds and is
not cloud-deployment evidence for this revision.

An isolated expiring Convex development deployment named `perfect-lark-558` was
provisioned for the review gate. No repository code has been uploaded to it. The
environment blocked that external upload pending explicit user approval for this
named destination. Therefore the packed-consumer cloud subscription and the full
100,000-row cloud run remain unexecuted and must not be summarized as passing.

The revised 100,000-row harness now:

- asserts exactly 99,990 survivors and validates every sequence, patch, delete,
  revision, and payload;
- compares structural records with raw sidecar entries for both indexes;
- proves every page used the requested index and traverses both indexes in both
  directions;
- reports wall time, p50/p95 page latency, documents/bytes read, job batches,
  application-observed OCC retries, failures, and document amplification; and
- purges the test table and asserts zero remaining tables.

## Publication state

The GitHub repository and package remain private. Release scripts fail closed.
No npm package, GitHub release, public repository, or Ente deployment was
created. A fresh production release review is still required after the cloud
gate passes.

## Re-review code references

- Same-transaction record and sidecar writes: `src/component/public.ts:556`,
  `src/component/public.ts:566`, `src/component/public.ts:617`,
  `src/component/public.ts:623`, and `src/component/data.ts:61`.
- Same-transaction backfill read and entry write:
  `src/component/indexJobs.ts:220-233`.
- Payload-hashed idempotency tuple: `src/component/normalization.ts:63`,
  `src/component/public.ts:548`, `src/component/public.ts:1164-1208`, and
  `src/component/schema.ts:117`.
- Ready-only planner selection: `src/component/planner.ts:113` and
  `src/component/planner.ts:160`.
- Read-only verification and fail-closed drift handling:
  `src/component/indexJobs.ts:344-504`.
- Index/table lifecycle generation fences: `src/component/indexJobs.ts:566-600`.
- Scope/resource-bound public pagination cursors:
  `src/component/public.ts:984-1038`.
