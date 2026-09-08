// Counting other live Claude Code sessions before a file-swap login switch.
//
// The swap rewrites the ONE credential store Claude Code reads, so a session
// that is already running can follow it to another account mid-conversation.
// Claude Code runs two ways: as the native `claude` binary (process name
// "claude") and as `node …/claude-code/cli.js` (process name "node") — the
// second is invisible to `pgrep -x claude`, which made the warning silently
// useless for npm installs.
//
// Whether a given session is actually affected is NOT knowable from the
// process list: a session launched through the proxy is served by swisscode,
// not by the shared store. The number is therefore an upper bound and the UI
// says "may". Pure by design — the caller supplies the probe.

/** Runs a command and resolves its stdout. Rejections are treated as "no matches". */
export type ProcessProbe = (command: string, args: string[]) => Promise<string>;

/** Native install: the binary is literally named `claude`. */
export const NATIVE_PROBE: readonly string[] = ["-x", "claude"];

/** npm install: node runs cli.js, so match the full command line instead. */
export const NODE_CLI_PROBE: readonly string[] = ["-f", "claude-code/cli\\.js"];

/** pgrep prints one pid per line; blank lines and junk are ignored. */
export function parsePids(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * Distinct Claude Code pids other than this process. Best effort: a probe that
 * fails (no `pgrep`, or no match — pgrep exits 1) contributes nothing rather
 * than aborting the count, because a missing count must not block a switch.
 */
export async function countOtherClaudeSessions(
  run: ProcessProbe,
  selfPid: number = process.pid,
): Promise<number> {
  const found = new Set<number>();
  for (const args of [NATIVE_PROBE, NODE_CLI_PROBE]) {
    let stdout = "";
    try {
      stdout = await run("pgrep", [...args]);
    } catch {
      continue;
    }
    for (const pid of parsePids(stdout)) {
      if (pid !== selfPid) found.add(pid);
    }
  }
  return found.size;
}
