# Query contract

`queryRecords` accepts `where`, optional `orderBy`, and pagination limits.

Supported predicates are `eq`, `lt`, `lte`, `gt`, and `gte`. A runtime index can
serve zero or more equality predicates on a contiguous field prefix and lower or
upper bounds on the next field. Ordering must match either the complete index or
the fields remaining after the equality prefix. Direction is wholly ascending or
wholly descending.

Additional predicates are evaluated after hydration. `plan.postFiltered` reports
this. Post filtering can shorten a page because the cursor advances over the
bounded sidecar read, not only returned records.

The planner selects only `ready` indexes. It returns:

```ts
{ kind: "index", indexId, postFiltered }
{ kind: "scan", postFiltered: false }
```

If no index matches, the component reads at most 201 records. Tables with at
most 200 records use an in-memory bounded scan. Larger tables throw
`INDEX_REQUIRED` and `explainQuery` returns a deterministic field list in
`suggestedIndex`; no partial data is returned.

Page size is 1 through 100. Cursors bind the component version, scope, table or
index, normalized query hash, and direction. Any mismatch returns
`INVALID_CURSOR`. Indexed cursors wrap the `convex-helpers` manual paginator
cursor. They are opaque API tokens, not authorization tokens or encrypted
secrets.

The manual paginator does not automatically inherit every native
reactive-pagination guarantee. Hosts that stitch reactive pages should carry an
`endCursor` and use the matching `convex-helpers` React pagination utilities.
Inserts, updates, or deletes can shorten a page, but the physical record ID
tie-break prevents duplicate keys.

## Value rules

- Optional missing values and explicit `null` both compare as indexed `null`.
- Text, select codes, and references remain case-sensitive strings.
- Numbers are finite and canonicalize `-0` to `0`.
- Timestamps are safe integer epoch milliseconds.
- Descending order reverses the complete native key.
- Mixed-direction composite order is unsupported.
