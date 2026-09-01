# Interactive showcase

The example app is the repository's runnable showcase and codegen host. It
creates a finance table entirely at runtime, including seven typed fields and
four online indexes. No transaction table appears in the host schema.

The sparse, table-first UI demonstrates:

- reactive reads and writes through host wrappers;
- runtime index selection as account, category, and sort filters change;
- residual post-filtering when a query includes predicates beyond an index;
- cursor pagination over runtime sidecars when the view grows;
- immediate `Untitled` row creation and inline visible-field editing;
- optimistic record revisions with compare-and-set patches and stale-write
  rejection;
- atomic record and sidecar deletion;
- an idempotent six-row sample reset through a unique runtime index.

Run all example and Convex commands from the repository root:

```sh
npm install
npm run dev
```

Open the `Showcase ready` URL printed by the command, build the runtime schema,
then load the sample data. Development uses a worktree-isolated anonymous local
Convex backend and does not publish a deployment.
