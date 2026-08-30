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
{ kind: "table", postFiltered: false }
{ kind: "scan", postFiltered: false }
```

An unfiltered query without a custom ordering always uses the structural
`records.by_scopeId_and_tableId` path, so a generic grid can paginate a large
table without a runtime index. For other queries, the component reads at most
201 records. Tables with at most 200 records use an in-memory bounded scan.
Larger tables throw `INDEX_REQUIRED` and `explainQuery` returns a deterministic
field list in `suggestedIndex`; no partial data is returned.

More than one range field returns `UNSUPPORTED_QUERY` with no index suggestion.
If a query would require more than the three supported index fields, it also
returns `UNSUPPORTED_QUERY`. Every emitted suggestion is therefore achievable.

Page size is 1 through 100. Read budgets must be positive finite integers and
cannot exceed 1,000 rows or 4,000,000 bytes. Cursors are capped at 8 KiB and
store the canonical result-shaping plan, `schemaRev`, scope, table or index, and
direction. Any mismatch returns `INVALID_CURSOR`. Indexed cursors wrap the
`convex-helpers` manual paginator cursor. They are opaque API tokens, not
authorization tokens or encrypted secrets.

The manual paginator does not automatically inherit every native
reactive-pagination guarantee. Hosts that stitch reactive pages should carry an
`endCursor` and use the matching `convex-helpers` React pagination utilities.
Inserts, updates, or deletes can shorten a page, but the physical record ID
tie-break prevents duplicate keys.

## Value rules

- Optional missing values and explicit `null` both compare as indexed `null`.
- Text, select codes, and references are NFC-normalized case-sensitive strings.
- Indexed strings are at most 1 KiB.
- Unique indexes allow multiple records with null or missing key parts. Upsert
  keys cannot contain null or missing parts.
- Failed and building indexes are not selected and do not enforce uniqueness. A
  build becomes ready only after repair and an independent duplicate check.
- Numbers are finite and canonicalize `-0` to `0`.
- Timestamps are safe integer epoch milliseconds.
- Descending order reverses the complete native key.
- Mixed-direction composite order is unsupported.
