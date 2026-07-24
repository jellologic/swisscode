#!/usr/bin/env node
// The fake agent that makes end-to-end launch testing possible.
//
// swisscode's whole job is to resolve a binary and hand off to it with a
// precise environment — and until now nothing tested that the handoff actually
// happens the way the plan says. Every test asserted on the PLAN (an in-memory
// object); none observed a real child process. This is the child process.
//
// The e2e harness points SWISSCODE_CLAUDE_BIN (and the kilo/opencode
// equivalents) at this file, then runs the REAL bin/swisscode.js. swisscode
// parses argv, loads the seeded config, resolves the profile, builds the env
// plan, and execve's (Node >= 23.11) or spawns (Node 22) into THIS. We write
// down exactly what we were handed and exit. The harness reads it back and
// asserts.
//
// WHY THIS IS NOT THE "do not launch for real" hazard CLAUDE.md warns about:
// that warning is about launching a REAL agent — a 250 MB interactive TUI that
// hangs a tool call and starts a nested session. This exits in milliseconds and
// touches no network, no credential, no keychain. It is the safe launch the
// warning leaves room for.
//
// It records `process.argv[1]` as `binary`: swisscode execve's the override
// path verbatim as argv[0], so a symlink named `recorder-claude` tells the test
// WHICH agent's binary swisscode resolved — proving the override selection, not
// only the lowered env.

import { writeFileSync } from 'node:fs'

const capturePath = process.env.SWISSCODE_E2E_CAPTURE

// Defensive: if this is ever reached without a capture target, it must still be
// a well-behaved no-op that exits cleanly rather than a crash that would read as
// a launch failure. In the harness the variable is always set.
if (!capturePath) {
  process.stderr.write('recorder: SWISSCODE_E2E_CAPTURE not set; nothing recorded\n')
  process.exit(0)
}

// `argv.slice(2)` is what swisscode forwarded to the agent: argv[0] is node,
// argv[1] is this script (the resolved binary path), the rest are the agent's
// arguments. `env` is captured WHOLE and asserted against by key — the point of
// an e2e is that an absent key proves the plan's `unset` reached the OS, which
// no plan-level assertion can show.
const record = {
  argv: process.argv.slice(2),
  env: { ...process.env },
  cwd: process.cwd(),
  binary: process.argv[1],
}

writeFileSync(capturePath, JSON.stringify(record))
process.exit(0)
