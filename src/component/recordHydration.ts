import type { PaginationResult } from "convex/server";
import { getConvexSize } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";

/** Bound full-record reads as well as sidecar reads. One record may cross the
 * soft byte boundary, just as in Convex pagination; never fetch the next one.
 * Re-pagination uses the same transaction snapshot and an exact row limit so
 * the continuation cursor never skips an unhydrated entry (even with endCursor).
 */
export async function hydrateRecordPage<
  Entry extends { recordId: Id<"records"> },
>(
  ctx: QueryCtx,
  initial: PaginationResult<Entry>,
  repaginate: (count: number) => Promise<PaginationResult<Entry>>,
  maximumBytesRead: number,
) {
  let bytes = getConvexSize(initial.page);
  const records: Array<Doc<"records"> | null> = [];
  for (const entry of initial.page) {
    if (records.length > 0 && bytes >= maximumBytesRead) break;
    const record = await ctx.db.get("records", entry.recordId);
    records.push(record);
    bytes += getConvexSize(record);
  }
  const result =
    records.length < initial.page.length
      ? await repaginate(records.length)
      : initial;
  return { result, records };
}
