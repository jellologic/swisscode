// The end-to-end harness: seed a config, run the REAL binary, read what it
// launched.
//
// This is the seam that lets a test observe swisscode's single most
// consequential act — the execve/spawn handoff — instead of trusting the plan
// object that describes it. Every helper here exists so a `.e2e.ts` file reads
// like a unit test while actually spawning `node bin/swisscode.js` end to end.
//
// HERMETIC BY CONSTRUCTION. Every run gets its own temp XDG dirs, its own
// capture file, and a set of symlinks pointing the three SWISSCODE_*_BIN
// overrides at the recorder. No network, no credential, no keychain, no shared
// state — the same discipline the unit fs-store tests already follow, one layer
// out.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const BIN = join(ROOT, 'bin', 'swisscode.js')
const DIST_CLI = join(ROOT, 'dist', 'cli.js')
const RECORDER = join(HERE, 'recorder.mjs')

/** The recorded child process — what swisscode actually handed the agent. */
export type Capture = {
  /** the arguments forwarded to the agent (swisscode's own flags already stripped) */
  argv: string[]
  /** the WHOLE child environment; assert by key — an absent key proves an unset */
  env: Record<string, string>
  cwd: string
  /** the resolved binary path; its basename names which agent was selected */
  binary: string
}

export type LaunchResult = {
  exitCode: number
  stdout: string
  stderr: string
  /** null when swisscode exited before handing off (an error, or `needsSetup`) */
  capture: Capture | null
}

/**
 * The deliberately polluted ambient environment, shared with `test/golden.test.ts`.
 *
 * The whole point of these vars is that they are WRONG: a stale key, a stale
 * gateway, stale tier models. If the launched child still carries any of them,
 * swisscode's `unset` did not reach the OS — which is exactly the failure a
 * plan-level test cannot see and this harness exists to catch.
 */
export const AMBIENT: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: 'sk-ant-STALE',
  ANTHROPIC_AUTH_TOKEN: 'stale-auth-token',
  ANTHROPIC_BASE_URL: 'https://stale.gateway.example',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable',
  CLAUDE_CODE_SUBAGENT_MODEL: 'stale-subagent',
})

/** The three override variables, and the symlink name each resolves to. */
const AGENT_OVERRIDES = {
  claude: 'SWISSCODE_CLAUDE_BIN',
  kilo: 'SWISSCODE_KILO_BIN',
  opencode: 'SWISSCODE_OPENCODE_BIN',
} as const

let distChecked = false
function ensureBuilt(): void {
  if (distChecked) return
  try {
    readFileSync(DIST_CLI)
    distChecked = true
  } catch {
    throw new Error(
      'e2e: dist/cli.js is missing — the e2e suite runs the built binary. Run `node build.js` first ' +
        '(the `test:e2e` npm script and CI both build before running).',
    )
  }
}

export type LaunchOptions = {
  /** the v3 config to seed; use `makeConfig` for the common shape */
  config: unknown
  /** everything after `swisscode` on the command line */
  argv?: string[]
  /** where the binary is invoked from — drives directory bindings */
  cwd?: string
  /**
   * Extra ambient env, merged over AMBIENT. Set a key to '' to REMOVE it from
   * the ambient the child inherits (spawnSync has no unset, so the harness
   * filters empties out of the final env).
   */
  env?: Record<string, string>
  /**
   * Point a SWISSCODE_*_BIN at something other than the recorder — used by the
   * recursion-guard test, which points it at swisscode itself.
   */
  overrideBins?: Partial<Record<keyof typeof AGENT_OVERRIDES, string>>
  /**
   * Tier B: install no recorders and set no overrides, so resolution finds the
   * REAL agent on PATH. There is no capture — the real binary does not write
   * one — so a Tier B assertion reads `exitCode`/`stdout` instead. Used only in
   * the Docker image where the three CLIs are installed.
   */
  useRealBinaries?: boolean
}

/**
 * Seed a config, run `node bin/swisscode.js <argv>`, and return the launch.
 *
 * The recorder writes its capture synchronously before exiting, so by the time
 * spawnSync returns the file is complete; there is no race to poll for.
 */
export function launch({
  config,
  argv = [],
  cwd,
  env = {},
  overrideBins = {},
  useRealBinaries = false,
}: LaunchOptions): LaunchResult {
  ensureBuilt()

  const work = mkdtempSync(join(tmpdir(), 'swisscode-e2e-'))
  const configDir = join(work, 'config', 'swisscode')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config), { mode: 0o600 })

  // The recorder is COPIED into the temp dir, not symlinked, and that is not a
  // detail. swisscode's recursion guard resolves every candidate binary with
  // `realpathSync` and rejects anything under its own install directory — which
  // is the repo root when the harness runs the built binary. A symlink resolves
  // BACK into the repo and gets rejected as "swisscode itself"; a copy under
  // /tmp resolves outside it and is accepted, exactly as a real agent would be.
  // (This is the guard working correctly, and the recursion-guard test relies
  // on it.) One copy per override so a resolved binary's basename tells the test
  // WHICH override variable swisscode consulted, not just which env it lowered.
  const capture = join(work, 'capture.json')
  const overrides: Record<string, string> = {}
  if (!useRealBinaries) {
    for (const [agent, variable] of Object.entries(AGENT_OVERRIDES)) {
      const explicit = overrideBins[agent as keyof typeof AGENT_OVERRIDES]
      if (explicit) {
        overrides[variable] = explicit
        continue
      }
      const copy = join(work, `recorder-${agent}`)
      copyFileSync(RECORDER, copy)
      chmodSync(copy, 0o755)
      overrides[variable] = copy
    }
  }

  // AMBIENT + caller env, with empty strings meaning "not present" so a test can
  // model an unpolluted shell for a specific variable.
  const merged: Record<string, string> = {
    // A minimal real shell: the child needs PATH to find `node` for the shebang,
    // and HOME because the default-config-dir logic reads it.
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? work,
    ...AMBIENT,
    ...env,
    ...overrides,
    XDG_CONFIG_HOME: join(work, 'config'),
    XDG_STATE_HOME: join(work, 'state'),
    SWISSCODE_E2E_CAPTURE: capture,
  }
  const childEnv = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ''))

  // `process.execPath`, not the string 'node', on purpose: the child swisscode
  // runs under the SAME Node as the suite. This is what finally exercises the
  // `execve` dispatch of replace() end to end — the handoff `ci.yml` admits
  // nothing covered. (The `spawn` fallback fires only where execve is absent,
  // i.e. Windows and Node < 23.11 — note even Node 22.23 backported execve — so
  // it stays unit-tested via spawnFallback + an injected SignalHost, and this
  // e2e does not reach it. Running the matrix under both supported Node versions
  // is defence in depth, not two different dispatches.)
  const run = spawnSync(process.execPath, [BIN, ...argv], {
    env: childEnv,
    ...(cwd ? { cwd } : {}),
    encoding: 'utf8',
  })

  let recorded: Capture | null = null
  try {
    recorded = JSON.parse(readFileSync(capture, 'utf8')) as Capture
  } catch {
    // No capture: swisscode exited before handing off (an error path, or it
    // needed setup). That is a legitimate, asserted-on outcome.
  }

  return {
    exitCode: run.status ?? 1,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    capture: recorded,
  }
}

// ── config fixtures ──

type AccountSpec = { provider: string; apiKey?: string; apiKeyFromEnv?: string; configDir?: string; baseUrl?: string }
type ProfileSpec = { agentProfile: string; accounts: string[]; strategy?: string }

/**
 * A v3 config, spelled at the density a test needs.
 *
 * Defaults to one openrouter key account, one claude-code agent profile pinning
 * a model, and one profile pairing them as the default — the smallest config
 * that launches. Any piece can be overridden.
 */
export function makeConfig(over: {
  providerAccounts?: Record<string, AccountSpec>
  agentProfiles?: Record<string, { agent?: string; models?: Record<string, string> }>
  profiles?: Record<string, ProfileSpec>
  defaultProfile?: string | null
  bindings?: Record<string, string>
  settings?: Record<string, unknown>
  providers?: Record<string, unknown>
} = {}): unknown {
  return {
    version: 3,
    providerAccounts: over.providerAccounts ?? { or: { provider: 'openrouter', apiKey: 'sk-e2e-or' } },
    agentProfiles: over.agentProfiles ?? { main: { agent: 'claude-code', models: { opus: 'openrouter/fusion' } } },
    profiles: over.profiles ?? { p: { agentProfile: 'main', accounts: ['or'] } },
    defaultProfile: 'defaultProfile' in over ? over.defaultProfile : 'p',
    bindings: over.bindings ?? {},
    settings: over.settings ?? {},
    ...(over.providers ? { providers: over.providers } : {}),
  }
}

/** basename of a resolved binary path, for `recorder-<agent>` assertions. */
export function resolvedAgent(capture: Capture): string {
  return capture.binary.split('/').pop() ?? capture.binary
}
