# Release evidence

Status: publication remains blocked. The deterministic local gates are green.
The required 100,000-row cloud-development gate has not run against this
revision, so this document does not claim release readiness.

## Local deterministic gates

- `npm test`: 94 tests across 8 files passed in 14.79 seconds with no type
  errors.
- `npm run test:coverage`: 94 tests passed in 48.15 seconds. Overall coverage is
  88.41% statements, 75.07% branches, 93.24% functions, and 90.70% lines.
  Critical-file branch coverage is planner 69.03%, index data 86.20%, and
  lifecycle jobs 80.86%.
- `npm run test:real-concurrency`: an anonymous local Convex backend passed 20
  two-client repetitions each for delete versus backfill, unique insertion,
  idempotent insertion, and expected-revision patching. R1 used 1,000 rows and
  asserted that the build was still queued or running immediately before the
  second client deleted its target. The final 5,000-row concurrent idempotent
  import reported 5,080 records and 5,080 exact sidecar entries after including
  the preceding race fixtures.
- `npm run test:consumer`: the exact tarball installed into a clean consumer,
  mounted the component, code-generated twice without drift, executed a mutation
  and query, and delivered a `ConvexClient.onUpdate` callback from a second
  client. The result was `mutation=ok`, `queryCount=1`, `reactiveCount=2`, and
  `codegenFresh=true`. It purged the reserved smoke scope before running, then
  ran the same fixture twice on that scope and returned `cleanup=succeeded`
  after both deletion jobs and zero-table checks. The tarball contained 104
  files and was 104.8 kB compressed / 653.6 kB unpacked. Its inspected contents
  had no test module or fault-injection hook.
- Focused hardening regressions prove stale/orphaned indexed reads return
  `INDEX_NOT_READY`, formerly-ready unique indexes block writes without partial
  state until repair, stalled ready-index verification can restart, and 192
  deterministic competing-index plans match an independent scan/sort.
- `SCALE_ROW_COUNT=1000 npm run test:scale`: the revised harness passed its
  exact known-survivor assertion, two independent raw-sidecar oracles, both
  indexes in both directions, selected-index checks on every page, and table
  purge with zero remaining tables. It completed in 14,585 ms with 990 expected
  survivors and 1,980 sidecar entries. Both build jobs succeeded in 24 batches
  with zero retries, mismatches, or terminal failures.
- The clean-worktree CI bootstrap (`convex dev --once`, component codegen, and
  generated-file diff) passed without a pre-existing `.env.local`.
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
provisioned for the review gate. GitHub run `33435188493` later uploaded commit
`44e77c05d3758377db574077857a49d140e5bac0`; its packed-consumer cloud
subscription passed, but the run was canceled during its 100,000-row step after
that SHA became obsolete. It does not certify commits `962bd9b` or `b62539b`.
The final-SHA hosted packed-consumer and 100,000-row gates remain pending and
must not be summarized as passing until a run completes with exact cleanup.

Hosted run `33439167267` targeted `c668a5268e48cde2c02178315e113f4f7389ff7c`.
Its packed-consumer step failed because the smoke wrapper reused fixed scope
`packed-consumer` and slug `items` left by the canceled run; the 100,000-row
step was skipped. This is a repeatable test-fixture cleanup defect, not evidence
of a component failure. The revised consumer preflights the fixed reserved scope
by deleting every table and waiting for every deletion job, so it also recovers
residue from an abruptly canceled process. It then executes twice on that same
scope, deletes each table through the component, and requires zero remaining
tables before reporting `cleanup="succeeded"`.

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
  `src/component/public.ts:548`, `src/component/public.ts:1169-1213`, and
  `src/component/schema.ts:120`.
- Ready-only planner selection: `src/component/planner.ts:113` and
  `src/component/planner.ts:160`.
- Indexed read drift containment: `src/component/planner.ts:384-424`.
- Post-ready unique enforcement: `src/component/data.ts:82-94` and
  `src/component/indexJobs.ts:477-514`.
- Read-only verification and fail-closed drift handling:
  `src/component/indexJobs.ts:344-504`.
- Index/table lifecycle generation fences: `src/component/indexJobs.ts:574-608`.
- Table-deletion child fences: `src/component/public.ts:943-983`.
- Scope/resource-bound public pagination cursors:
  `src/component/public.ts:986-1048`.
