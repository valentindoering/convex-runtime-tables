import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { Pagination, QuerySpec } from "./planner.js";
import { convexTest } from "convex-test";
import schema from "./schema.js";
import { modules } from "./setup.test.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("large valid records build, verify, paginate and purge within enforced transaction limits", async () => {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const scopeId = "large-records";
  const { table, fields } = await t.mutation(api.public.createTable, {
    scopeId,
    slug: "large",
    name: "Large",
    fields: [
      { key: "seq", name: "Seq", type: "number", required: true },
      { key: "body", name: "Body", type: "text", required: false },
    ],
  });
  const seq = fields[0]!._id;
  const body = fields[1]!._id;
  const args = { scopeId, tableId: table._id };
  for (let n = 0; n < 30; n++) {
    await t.mutation(api.public.insertRecords, {
      ...args,
      records: [{ values: { [seq]: n, [body]: "x".repeat(600_000) } }],
    });
  }
  const query: QuerySpec = {
    where: [],
    orderBy: { fieldIds: [seq], direction: "asc" },
  };
  expect(
    (await t.query(api.public.explainQuery, { ...args, query })).kind,
  ).toBe("indexRequired");
  await expect(
    t.query(api.public.queryRecords, {
      ...args,
      query,
      pagination: { pageSize: 100 },
    }),
  ).rejects.toThrow("INDEX_REQUIRED");
  const index = await t.mutation(api.public.createIndex, {
    ...args,
    name: "by_seq",
    fieldIds: [seq],
    unique: false,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(
    (await t.query(api.public.getJob, { scopeId, jobId: index.jobId }))?.state,
  ).toBe("succeeded");
  for (const direction of ["asc", "desc"] as const) {
    let cursor: string | undefined;
    const seen: number[] = [];
    for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
      const page = await t.query(api.public.queryRecords, {
        ...args,
        query: { ...query, orderBy: { fieldIds: [seq], direction } },
        pagination: { pageSize: 100, ...(cursor ? { cursor } : {}) },
      });
      expect(page.page.length).toBeLessThan(10);
      seen.push(...page.page.map((row) => row.values[seq] as number));
      if (page.isDone) break;
      expect(page.continueCursor).not.toBe(cursor);
      cursor = page.continueCursor!;
    }
    expect(seen).toEqual(
      Array.from({ length: 30 }, (_, n) => (direction === "asc" ? n : 29 - n)),
    );
  }
  const deletion = await t.mutation(api.public.deleteTable, args);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(
    (await t.query(api.public.getJob, { scopeId, jobId: deletion.jobId }))
      ?.state,
  ).toBe("succeeded");
  expect(
    (
      await t.query(api.public.listTables, {
        scopeId,
        pagination: { pageSize: 1 },
      })
    ).page,
  ).toEqual([]);
});

async function fixture(count: number) {
  const t = initConvexTest();
  const scopeId = "release-regression";
  const created = await t.mutation(api.public.createTable, {
    scopeId,
    slug: "rows",
    name: "Rows",
    fields: ["a", "b", "c"].map((key) => ({
      key,
      name: key,
      type: "number" as const,
      required: false,
    })),
  });
  const [a, b, c] = created.fields.map((field) => field._id);
  const tableId = created.table._id;
  for (let offset = 0; offset < count; offset += 100) {
    await t.mutation(api.public.insertRecords, {
      scopeId,
      tableId,
      records: Array.from(
        { length: Math.min(100, count - offset) },
        (_, n) => ({
          values: { [a!]: 1, [b!]: offset + n, [c!]: (offset + n) % 3 },
        }),
      ),
    });
  }
  return { t, scopeId, tableId, a: a!, b: b!, c: c! };
}

test("equality fields at every ordering position never produce an unachievable suggestion", async () => {
  const { t, scopeId, tableId, a, b, c } = await fixture(201);
  const orders = [
    [a],
    [b],
    [a, b],
    [b, a],
    [a, b, c],
    [b, a, c],
    [b, c, a],
    [c, b, a],
  ];
  for (const fieldIds of orders) {
    for (const direction of ["asc", "desc"] as const) {
      const query: QuerySpec = {
        where: [{ fieldId: a, op: "eq", value: 1 }],
        orderBy: { fieldIds, direction },
      };
      const plan = await t.query(api.public.explainQuery, {
        scopeId,
        tableId,
        query,
      });
      expect(plan.kind).toBe("indexRequired");
      if (plan.kind !== "indexRequired") throw new Error("Expected suggestion");
      const index = await t.mutation(api.public.createIndex, {
        scopeId,
        tableId,
        name: "suggested",
        fieldIds: plan.suggestedIndex,
        unique: false,
      });
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      expect(
        (await t.query(api.public.explainQuery, { scopeId, tableId, query }))
          .kind,
      ).toBe("index");
      await t.mutation(api.public.deleteIndex, {
        scopeId,
        indexId: index.indexId,
      });
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    }
  }
  await expect(
    t.query(api.public.explainQuery, {
      scopeId,
      tableId,
      query: {
        where: [{ fieldId: b, op: "gte", value: 1 }],
        orderBy: { fieldIds: [c, b], direction: "asc" },
      },
    }),
  ).rejects.toThrow("UNSUPPORTED_QUERY");
}, 30_000);

test.each(["asc", "desc"] as const)(
  "scan endCursor pins the inclusive boundary in %s order and validates plan identity",
  async (direction) => {
    const { t, scopeId, tableId, b } = await fixture(5);
    const query: QuerySpec = {
      where: [],
      orderBy: { fieldIds: [b], direction },
    };
    const first = await t.query(api.public.queryRecords, {
      scopeId,
      tableId,
      query,
      pagination: { pageSize: 2 },
    });
    expect(first.plan.kind).toBe("scan");
    const validPayload = JSON.parse(
      decodeURIComponent(first.continueCursor!.slice(5)),
    );
    for (const patch of [
      { boundaryValues: undefined },
      { boundaryValues: null },
      { boundaryValues: [] },
      { boundaryValues: [1, 2] },
      { boundaryValues: [{}] },
      { boundaryValues: [[1]] },
      { recordId: undefined },
      { recordId: null },
      { recordId: 123 },
      { recordId: "" },
      { recordId: "x".repeat(101) },
    ]) {
      const malformed = `crt2:${encodeURIComponent(JSON.stringify({ ...validPayload, ...patch }))}`;
      for (const key of ["cursor", "endCursor"] as const) {
        await expect(
          t.query(api.public.queryRecords, {
            scopeId,
            tableId,
            query,
            pagination: { pageSize: 5, [key]: malformed },
          }),
        ).rejects.toThrow("INVALID_CURSOR");
      }
    }
    const nonfinite = `crt2:${encodeURIComponent(JSON.stringify(validPayload).replace(/"boundaryValues":\[[^\]]*\]/, '"boundaryValues":[1e400]'))}`;
    for (const key of ["cursor", "endCursor"] as const) {
      await expect(
        t.query(api.public.queryRecords, {
          scopeId,
          tableId,
          query,
          pagination: { pageSize: 5, [key]: nonfinite },
        }),
      ).rejects.toThrow("INVALID_CURSOR");
    }
    const pinned = await t.query(api.public.queryRecords, {
      scopeId,
      tableId,
      query,
      pagination: { pageSize: 5, endCursor: first.continueCursor! },
    });
    expect(pinned.page).toEqual(first.page);
    expect(pinned.continueCursor).toBe(first.continueCursor);
    expect(pinned.isDone).toBe(false);
    const smaller = await t.query(api.public.queryRecords, {
      scopeId,
      tableId,
      query,
      pagination: { pageSize: 1, endCursor: first.continueCursor! },
    });
    expect(smaller.page).toEqual(first.page);
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId,
        query,
        pagination: { pageSize: 5, endCursor: "not-a-cursor" },
      }),
    ).rejects.toThrow("INVALID_CURSOR");
    await expect(
      t.query(api.public.queryRecords, {
        scopeId,
        tableId,
        query: {
          ...query,
          orderBy: {
            fieldIds: [b],
            direction: direction === "asc" ? "desc" : "asc",
          },
        },
        pagination: { pageSize: 5, endCursor: first.continueCursor! },
      }),
    ).rejects.toThrow("INVALID_CURSOR");
  },
);

test("operator cursors reject malformed inner cursors with structured errors", async () => {
  const { t, scopeId, tableId, b } = await fixture(2);
  const index = await t.mutation(api.public.createIndex, {
    scopeId,
    tableId,
    name: "by_b",
    fieldIds: [b],
    unique: false,
  });
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const defaultQuery: QuerySpec = { where: [] };
  const indexedQuery: QuerySpec = {
    where: [],
    orderBy: { fieldIds: [b], direction: "asc" },
  };
  const recordCases = await Promise.all(
    [defaultQuery, indexedQuery].map(async (query) => {
      const first = await t.query(api.public.queryRecords, {
        scopeId,
        tableId,
        query,
        pagination: { pageSize: 1 },
      });
      return {
        query,
        payload: JSON.parse(decodeURIComponent(first.continueCursor!.slice(5))),
      };
    }),
  );
  const malformedInners = [
    "garbage",
    "null",
    "{}",
    "123",
    "true",
    '"text"',
    "[{}]",
    "[[]]",
    "[1e400]",
    JSON.stringify(Array(9).fill(0)),
    '[{"$integer":"AAAAAAAAAAA="}]',
  ];
  for (const inner of malformedInners) {
    for (const key of ["cursor", "endCursor"] as const) {
      const malformed = (kind: string, resourceId: string) =>
        `crt-op1:${encodeURIComponent(JSON.stringify({ version: 1, kind, scopeId, resourceId, inner }))}`;
      for (const { query, payload } of recordCases) {
        const cursor = `crt2:${encodeURIComponent(JSON.stringify({ ...payload, inner }))}`;
        await expect(
          t.query(api.public.queryRecords, {
            scopeId,
            tableId,
            query,
            pagination: { pageSize: 1, [key]: cursor },
          }),
        ).rejects.toThrow("INVALID_CURSOR");
      }
      await expect(
        t.query(api.public.listTables, {
          scopeId,
          pagination: { pageSize: 1, [key]: malformed("listTables", scopeId) },
        }),
      ).rejects.toThrow("INVALID_CURSOR");
      await expect(
        t.query(api.public.auditIndexEntries, {
          scopeId,
          indexId: index.indexId,
          pagination: {
            pageSize: 1,
            [key]: malformed("auditIndexEntries", index.indexId),
          },
        }),
      ).rejects.toThrow("INVALID_CURSOR");
    }
  }
});

test.each([
  ["table", 4],
  ["index", 8],
  ["listTables", 4],
  ["auditIndexEntries", 5],
] as const)(
  "%s cursor keys cannot exceed their physical index's %i slots",
  async (kind, keyCount) => {
    const { t, scopeId, tableId, b } = await fixture(3);
    await t.mutation(api.public.createTable, {
      scopeId,
      slug: "second",
      name: "Second",
      fields: [],
    });
    const index = await t.mutation(api.public.createIndex, {
      scopeId,
      tableId,
      name: "by_b",
      fieldIds: [b],
      unique: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    const queryPage = (pagination: Pagination) => {
      if (kind === "listTables") {
        return t.query(api.public.listTables, { scopeId, pagination });
      }
      if (kind === "auditIndexEntries") {
        return t.query(api.public.auditIndexEntries, {
          scopeId,
          indexId: index.indexId,
          pagination,
        });
      }
      return t.query(api.public.queryRecords, {
        scopeId,
        tableId,
        pagination,
        query: {
          where: [],
          ...(kind === "index"
            ? { orderBy: { fieldIds: [b], direction: "asc" as const } }
            : {}),
        },
      });
    };
    const first = await queryPage({ pageSize: 1 });
    expect(first.continueCursor).not.toBeNull();
    const prefix = kind === "table" || kind === "index" ? "crt2:" : "crt-op1:";
    const payload = JSON.parse(
      decodeURIComponent(first.continueCursor!.slice(prefix.length)),
    );
    const keys = JSON.parse(payload.inner) as unknown[];
    // Lock the tests to the actual helper encoding, including its two system keys.
    expect(keys).toHaveLength(keyCount);
    const encode = (innerKeys: unknown[]) =>
      `${prefix}${encodeURIComponent(JSON.stringify({ ...payload, inner: JSON.stringify(innerKeys) }))}`;
    for (const boundary of ["cursor", "endCursor"] as const) {
      // Valid complete keys and the helper's supported prefix boundaries still work.
      for (let length = 0; length <= keyCount; length++) {
        await expect(
          queryPage({ pageSize: 1, [boundary]: encode(keys.slice(0, length)) }),
        ).resolves.toHaveProperty("page");
      }
      for (let length = keyCount + 1; length <= 10; length++) {
        await expect(
          queryPage({
            pageSize: 1,
            [boundary]: encode([
              ...keys,
              ...Array(length - keyCount).fill("extra"),
            ]),
          }),
        ).rejects.toThrow("INVALID_CURSOR");
      }
    }
    const second = await queryPage({
      pageSize: 1,
      cursor: first.continueCursor!,
    });
    expect(second.page).toHaveLength(1);
    expect(second.page).not.toEqual(first.page);
  },
);
