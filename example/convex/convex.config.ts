import { defineApp } from "convex/server";
import runtimeTables from "convex-runtime-tables/convex.config.js";

const app = defineApp();
app.use(runtimeTables);

export default app;
