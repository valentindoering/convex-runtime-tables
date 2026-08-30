# Release evidence

Status: all implementation gates are green. Publication remains blocked pending
a fresh production release review.

## Local deterministic gates

- `npm test`: 62 tests across 8 files passed. This includes nine race cases,
  each repeated 20 times with an independent sidecar oracle.
- `npm run typecheck`: package, example frontend, and example Convex functions
  passed.
- `npm run test:coverage`: 62 tests passed. Overall coverage is 84.71%
  statements, 70.44% branches, 90.22% functions, and 87.11% lines. Critical-file
  branch coverage is planner 62.10%, index data 81.81%, and lifecycle jobs
  78.39%.
- `npm run test:consumer`: passed against a clean tarball consumer. Output:
  `mutation=ok`, `queryCount=1`, `reactiveCount=2`, `codegenFresh=true`. The
  tarball contained 115 files and was 106.5 kB compressed / 648.9 kB unpacked.

## 100k deployment gate

The first clean run loaded 100,000 records and completed concurrent writes, but
one build job exceeded a 30-minute post-import deadline at `batchCount=2183`,
`progress=436370`, `retryCount=0`, and zero reported verification mismatches.
That run is a failure, not a pass.

The lifecycle batch size was increased from 50 to 200 and a redundant per-entry
duplicate lookup was removed behind repair-only duplicate handling. The final
exact-tree run then passed:

- 100,000 records imported; 10 deliberate concurrent deletes left 99,990.
- Two index builds succeeded with 2,429 batches each, zero retries, and zero
  verification mismatches.
- Separate operator verification jobs succeeded with 1,000 batches each, zero
  retries, and zero mismatches while the ready indexes continued serving.
- Full ascending and descending traversals each used 1,000 pages and produced
  exact reverse-order ID sets without gaps or duplicates.
- Wall time was 3,915,644 ms.
- Ascending page latency was 202.711 ms p50 and 376.245 ms p95. Page 1 was
  428.344 ms; the deep page was 199.427 ms.
- Indexed reads were 206 documents / 60,339 bytes at p50, p95, page 1, and the
  deep page.
- Document storage amplification was exactly two sidecar entries per surviving
  record, or 199,980 index-entry documents.
- Application-observed OCC retries and failures were both zero.

The local Convex client does not expose hidden client/runtime OCC retries, so
the reported retry counter covers errors observed by the benchmark retry loop.
Exact on-disk byte amplification requires a deployment export; this gate records
exact document amplification and transaction bytes read.

## Publication state

The repository and package remain private. All release scripts fail closed. No
npm package, GitHub release, public repository, or Ente deployment was created.

## Re-review code references

- Same-transaction record and sidecar writes: `src/component/public.ts:455-465`,
  `src/component/public.ts:514-522`, and `src/component/data.ts:61-72`.
- Same-transaction backfill read and entry write:
  `src/component/indexJobs.ts:26-52` and `src/component/indexJobs.ts:220-233`.
- Payload-hashed idempotency tuple: `src/component/normalization.ts:63-68`,
  `src/component/public.ts:1003-1056`, and `src/component/schema.ts:117-136`.
- Ready-only planner selection: `src/component/planner.ts:233-244`.
- Read-only verification comparisons: `src/component/indexJobs.ts:344-451`.
- Invocation, index, and table generation fences:
  `src/component/indexJobs.ts:503-591`.
