import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { jobKindValidator, jobPhaseValidator } from "./validators.js";

export const process = internalAction({
  args: {
    jobId: v.id("jobs"),
    generation: v.number(),
    kind: jobKindValidator,
    phase: jobPhaseValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batchArgs = {
      jobId: args.jobId,
      generation: args.generation,
      phase: args.phase,
    };
    try {
      if (
        args.kind === "buildIndex" ||
        args.kind === "repairIndex" ||
        args.kind === "verifyIndex"
      ) {
        await ctx.runMutation(internal.indexJobs.runIndexBatch, batchArgs);
      } else if (args.kind === "deleteIndex") {
        await ctx.runMutation(
          internal.indexJobs.runDeleteIndexBatch,
          batchArgs,
        );
      } else {
        await ctx.runMutation(
          internal.indexJobs.runDeleteTableBatch,
          batchArgs,
        );
      }
    } catch (error) {
      const failure = structuredFailure(error);
      await ctx.runMutation(internal.indexJobs.markUnexpectedFailure, {
        jobId: args.jobId,
        generation: args.generation,
        kind: args.kind,
        code: failure.code,
        message: failure.message,
        samples: failure.samples,
      });
    }
    return null;
  },
});

function structuredFailure(error: unknown): {
  code: string;
  message: string;
  samples: string[];
} {
  const fallback = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object" || !("data" in error)) {
    return { code: "UNEXPECTED_FAILURE", message: fallback, samples: [] };
  }
  const data = error.data;
  if (!data || typeof data !== "object") {
    return { code: "UNEXPECTED_FAILURE", message: fallback, samples: [] };
  }
  const record = data as Record<string, unknown>;
  const details =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : {};
  return {
    code: typeof record.code === "string" ? record.code : "UNEXPECTED_FAILURE",
    message: typeof record.message === "string" ? record.message : fallback,
    samples: typeof details.recordId === "string" ? [details.recordId] : [],
  };
}
