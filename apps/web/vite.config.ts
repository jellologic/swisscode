import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const workspace = fileURLToPath(new URL("../../packages", import.meta.url));

export default defineConfig({
  plugins: [
    tanstackStart(),
    viteReact(),
  ],
  resolve: {
    // Workspace sources, not compiled dist: adapter edits hot-reload in dev
    // and production bundles never depend on a prior `tsc` run.
    alias: [
      { find: "@swisscode/adapters", replacement: `${workspace}/adapters/src/index.ts` },
      { find: "@swisscode/core", replacement: `${workspace}/core/src/index.ts` },
    ],
  },
});
