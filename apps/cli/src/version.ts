/**
 * Build-time-baked swisscode version. esbuild replaces `SWISSCODE_VERSION`
 * via `--define` (see package.json `bundle` script, single source = this
 * package's own version); tsc runs and tests see the `dev` fallback.
 */
declare const SWISSCODE_VERSION: string | undefined;

/** Running CLI version for `--version` and update checks. */
export function currentVersion(): string {
  return typeof SWISSCODE_VERSION !== "undefined" && SWISSCODE_VERSION !== ""
    ? SWISSCODE_VERSION
    : "dev";
}
