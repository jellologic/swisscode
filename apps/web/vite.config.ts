import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const workspace = fileURLToPath(new URL("../../packages", import.meta.url));

// Single source of truth: the CLI manifest (all manifests version in lockstep).
const cliManifest = JSON.parse(
  readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __SWISSCODE_VERSION__: JSON.stringify(cliManifest.version),
  },
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
