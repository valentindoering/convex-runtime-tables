import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "src/component/faults.test.ts"],
    environment: "edge-runtime",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    coverage: {
      thresholds: {
        branches: 60,
        lines: 80,
        functions: 80,
        statements: 75,
        "src/component/planner.ts": { branches: 50, lines: 80 },
        "src/component/data.ts": { branches: 80, lines: 80 },
        "src/component/indexJobs.ts": { branches: 65, lines: 80 },
      },
    },
  },
});
