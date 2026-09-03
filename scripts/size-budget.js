// The published tarball has a ceiling, and busting it is a build failure.
//
// swisscode is a launcher whose pitch is that it is small and gets out of the
// way. Shipping a web UI means every user downloads a React bundle they may
// never open — a deliberate trade, made once. This script is what stops that
// trade being silently re-made, a few kilobytes at a time, by changes nobody
// weighed.
//
// It measures `npm pack`, not the source tree: what matters is what users
// actually download, and `files` (bin, dist, README) is what decides that.

import { execFileSync } from 'node:child_process'

/**
 * Packed (gzipped) tarball ceiling, in kilobytes.
 *
 * Set with headroom over the current artifact, not flush against it: a budget
 * that fails on the next honest change trains people to raise it reflexively,
 * which is the same as not having one. Raising it should be a visible line in a
 * diff with a reason attached.
 *
 * LOWERED from 260 to 150 when the artifact fell to ~118 kB — stripping comments
 * from the emitted JS, minifying dist/ui.js, and swapping react-dom for
 * preact/compat in the browser bundle. A ceiling with more slack beneath it than
 * artifact above it is not a budget; it is a number.
 *
 * RAISED to 175 for `config proxy`, the local gateway (+4.8 kB packed). Two
 * things are worth recording about that number, because the 150 it replaced had
 * quietly stopped doing its job:
 *
 * The artifact had drifted from ~118 kB to 147.7 kB — 2.3 kB, or 1.5%, under
 * the ceiling — while this comment still claimed ~27% headroom. A budget that
 * flush fails on the next honest change, which is exactly the reflexive-raise
 * failure the paragraph above warns about; it had become that, unnoticed,
 * because nothing re-reads a number that keeps passing.
 *
 * The gateway is the same trade as the web UI: everyone downloads it, most
 * people never start it. 4.8 kB for failover across providers is a trade worth
 * making once — and, like the web UI, it is the reason to keep measuring rather
 * than an excuse to stop.
 */
const BUDGET_KB = 175

// `--ignore-scripts` because `prepare` runs the whole build, and this script is
// meant to MEASURE the artifact, not rebuild it — in CI the build has already
// happened, and rebuilding here would double the work and hide a stale dist/.
const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
})

/**
 * Find the JSON array, tolerantly.
 *
 * The first attempt sliced from the first `[` and broke immediately: npm emits
 * ANSI control sequences (`[2K`) around progress output, so the first `[`
 * in the stream belonged to an escape code rather than to the payload. Strip
 * the escapes first, then match an array that actually starts with an object.
 */
const clean = raw.replace(/\[[0-9;]*[a-zA-Z]/g, '')
const match = clean.match(/\[\s*\{[\s\S]*\}\s*\]/)
if (!match) {
  console.error('could not find the pack report in npm output')
  process.exit(1)
}
const report = JSON.parse(match[0])
const { size, unpackedSize, entryCount } = report[0]

const kb = size / 1000
const line = `tarball ${kb.toFixed(1)} kB packed · ${(unpackedSize / 1000).toFixed(1)} kB unpacked · ${entryCount} files`

if (kb > BUDGET_KB) {
  console.error(`size budget EXCEEDED: ${line} (ceiling ${BUDGET_KB} kB)`)
  console.error(
    'Either shrink what ships, or raise BUDGET_KB in scripts/size-budget.js with a note ' +
      'saying what grew and why it is worth it to someone who never opens the web UI.',
  )
  process.exit(1)
}

console.log(`size budget ok: ${line} (ceiling ${BUDGET_KB} kB, ${(BUDGET_KB - kb).toFixed(1)} kB spare)`)
