import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval(
  "runtime tables retention sweep",
  { hours: 1 },
  internal.maintenance.cleanupExpired,
  {},
);

export default crons;
