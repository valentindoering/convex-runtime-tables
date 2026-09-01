import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config.js";
import runtimeTables from "convex-runtime-tables/convex.config.js";

const app = defineApp();
app.use(runtimeTables);
app.use(staticHosting, { name: "selfHosting" });

export default app;
