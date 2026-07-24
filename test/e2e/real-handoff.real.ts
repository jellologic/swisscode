// Tier B: swisscode against the REAL coding CLIs.
//
// Tier A (the *.e2e.ts files) proves swisscode builds the right launch by
// pointing the SWISSCODE_*_BIN overrides at a recorder. That is complete and
// deterministic, but it can never catch an UPSTREAM change — a renamed flag, a
// rejected environment variable, a binary that moved. This tier installs the
// three actual CLIs (`@anthropic-ai/claude-code`, `@kilocode/cli`,
// `opencode-ai`) and proves swisscode resolves each one and hands off to it.
//
// NON-BILLABLE BY CONSTRUCTION. It forwards only `--version`, which every CLI
// answers before any authentication or inference — no API key, no network to a
// model, no cost. It is the smallest act that proves resolution + env dialect +
// the execve handoff against the genuine binary.
//
// A DISTINCT `.real.ts` EXTENSION, not `.e2e.ts`, keeps it out of the hermetic
// pass: `test:e2e` globs `*.e2e.ts` and never sees this, so a PR that has not
// installed the three CLIs stays green. This runs only via `test:e2e:real`,
// inside the Docker image, or by hand.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { launch, makeConfig } from './harness.ts'

/**
 * Is this binary on PATH at all?
 *
 * Detected by trying to run it and watching for ENOENT rather than shelling out
 * to `which`, which `node:*-slim` images do not ship. The timeout guards a CLI
 * whose `--version` might not short-circuit as cleanly as expected — the whole
 * risk this tier was told to verify.
 */
function installed(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 })
  return !(r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT')
}

const AGENTS = [
  { id: 'claude-code', bin: 'claude', model: 'claude-opus-4-8' },
  { id: 'kilo', bin: 'kilo', model: 'anthropic/claude-opus-4-8' },
  { id: 'opencode', bin: 'opencode', model: 'anthropic/claude-opus-4-8' },
]

for (const agent of AGENTS) {
  test(`swisscode resolves and hands off to the real ${agent.bin} (--version)`, { skip: !installed(agent.bin) }, () => {
    const r = launch({
      config: makeConfig({
        providerAccounts: { a: { provider: 'openrouter', apiKey: 'sk-e2e-not-used-by-version' } },
        agentProfiles: { m: { agent: agent.id, models: { opus: agent.model } } },
        profiles: { p: { agentProfile: 'm', accounts: ['a'] } },
      }),
      argv: ['--version'],
      useRealBinaries: true,
    })

    // The real binary printed its version and exited cleanly. There is no
    // capture — the genuine CLI does not write our file — so the exit code and
    // stdout ARE the assertion.
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`)
    assert.match(r.stdout + r.stderr, /\d+\.\d+\.\d+/, 'expected a version string from the real CLI')
    assert.equal(r.capture, null, 'a real handoff writes no recorder capture')
  })
}

test('at least one real CLI was actually exercised', () => {
  // A guard against the whole tier silently no-opping: if the image is built
  // right, all three are installed. If NONE are, this fails loudly rather than
  // reporting a reassuring row of skips.
  assert.ok(
    AGENTS.some((a) => installed(a.bin)),
    'no real coding CLI is installed — Tier B proved nothing. Check the Dockerfile installs.',
  )
})
