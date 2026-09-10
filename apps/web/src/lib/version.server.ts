/**
 * Build-time-baked swisscode version. Vite replaces `__SWISSCODE_VERSION__`
 * via `define` (see vite.config.ts, single source = apps/cli/package.json);
 * anything else (tsc typecheck, tests) sees the `dev` fallback.
 */
declare const __SWISSCODE_VERSION__: string | undefined;

/** Running server version for the UI badge and update checks. */
export function serverVersion(): string {
  return typeof __SWISSCODE_VERSION__ !== "undefined" && __SWISSCODE_VERSION__ !== ""
    ? __SWISSCODE_VERSION__
    : "dev";
}
