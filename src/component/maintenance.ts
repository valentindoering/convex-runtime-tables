import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";
import { JOB_STALL_MS } from "./validation.js";

const CLEANUP_BATCH = 100;

export const cleanupExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const keys = await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(CLEANUP_BATCH);
    for (const key of keys) await ctx.db.delete("idempotencyKeys", key._id);

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_retentionExpiresAt", (q) =>
        q.gt("retentionExpiresAt", undefined).lte("retentionExpiresAt", now),
      )
      .take(CLEANUP_BATCH);
    for (const job of jobs) await ctx.db.delete("jobs", job._id);

    const stalledGroups: Doc<"jobs">[][] = [];
    for (const state of ["queued", "running"] as const) {
      stalledGroups.push(
        await ctx.db
          .query("jobs")
          .withIndex("by_state_and_updatedAt", (q) =>
            q.eq("state", state).lt("updatedAt", now - JOB_STALL_MS),
          )
          .take(CLEANUP_BATCH + 1),
      );
    }
    const stalled = stalledGroups.flat();
    for (const job of stalled.slice(0, CLEANUP_BATCH)) {
      await ctx.scheduler.runAfter(
        0,
        internal.indexJobs.markUnexpectedFailure,
        {
          jobId: job._id,
          generation: job.generation ?? 0,
          kind: job.kind,
          code: "JOB_STALLED",
          message: `Job made no progress for ${JOB_STALL_MS} ms`,
          samples: [],
        },
      );
    }

    if (
      keys.length === CLEANUP_BATCH ||
      jobs.length === CLEANUP_BATCH ||
      stalled.length >= CLEANUP_BATCH
    ) {
      await ctx.scheduler.runAfter(0, internal.maintenance.cleanupExpired, {});
    }
    return null;
  },
});
