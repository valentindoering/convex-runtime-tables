import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "../",
  plugins: [react()],
  server: { allowedHosts: [".ts.net"] },
  resolve: {
    conditions: ["@convex-dev/component-source"],
  },
});
