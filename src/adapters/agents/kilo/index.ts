// The Kilo adapter (@kilocode/cli, binary `kilo`).
//
// Kilo reads a full config inline from KILO_CONFIG_CONTENT (no file written) and
// selects a model as `provider/model`. It exposes ONE model slot, so the
// profile's opus tier drives it and the other tiers warn rather than vanish.
//
// Permissions: Kilo documents `--auto` on `kilo run`, but not on the top-level
// interactive `kilo`, so we auto-approve through the config `permission` block
// instead (subcommand-agnostic). Both mechanisms are isolated behind constants.
//
// SCHEMA CONSTANTS — from https://kilo.ai/docs/code-with-ai/platforms/cli.
// Kilo's docs are terse on the custom-provider shape; these mirror OpenCode's
// (shared @ai-sdk lineage) and are pinned by the test + verified by smoke test.

import { join } from 'node:path'
import {
  ANTHROPIC_SDK_NPM,
  PROVIDER_KEY,
  ambientUnset,
  anthropicOptions,
  collapsedTierWarning,
  compatIgnoredWarning,
  sessionUnavailableWarning,
  extendedContextWarning,
  modelRef,
  modelsBlock,
} from '../shared.ts'
import type { AgentCliPort, EnvWarning, TranslateInput, Translation } from '../../../ports/agent.ts'
import type { AgentBinarySpec } from '../../../ports/process.ts'

/** Env var Kilo reads an inline config from. */
export const KILO_CONFIG_ENV = 'KILO_CONFIG_CONTENT'
/** The `permission` value that auto-approves every action. */
export const KILO_ALLOW_ALL: Record<string, string> = { '*': 'allow' }

const binary: AgentBinarySpec = {
  name: 'kilo',
  overrideEnv: 'SWISSCODE_KILO_BIN',
  fallbacks: (home: string) => [
    join(home, '.local', 'bin', 'kilo'),
    join(home, '.kilo', 'bin', 'kilo'),
    '/usr/local/bin/kilo',
    '/opt/homebrew/bin/kilo',
  ],
}

export const kilo = {
  id: 'kilo',
  label: 'Kilo CLI',
  capabilities: {
    models: 'single',
    skipPermissions: true,
    extendedContextSuffix: false,
    compatFlags: false,
    // Kilo takes its credential inline in KILO_CONFIG_CONTENT and has no notion of
    // an existing login directory, so a session-mode account gives it nothing.
    sessionDir: false,
  },
  binary,
  translate(input: TranslateInput): Translation {
    const { intent, passthrough, profile } = input
    const primary = intent.models.opus

    const config: Record<string, unknown> = {
      provider: {
        [PROVIDER_KEY]: {
          npm: ANTHROPIC_SDK_NPM,
          name: PROVIDER_KEY,
          options: anthropicOptions(intent),
          models: modelsBlock([primary]),
        },
      },
    }
    if (primary) config.model = modelRef(primary)
    if (intent.skipPermissions) config.permission = KILO_ALLOW_ALL

    const set: Record<string, string> = { [KILO_CONFIG_ENV]: JSON.stringify(config) }

    const warnings: EnvWarning[] = []
    const noSession = sessionUnavailableWarning(intent, 'Kilo')
    if (noSession) warnings.push(noSession)
    const collapse = collapsedTierWarning(intent, ['opus'], 'Kilo')
    if (collapse) warnings.push(collapse)
    const ext = extendedContextWarning(intent, primary, 'Kilo')
    if (ext) warnings.push(ext)
    const compat = compatIgnoredWarning(profile.compat, 'Kilo')
    if (compat) warnings.push(compat)

    return { plan: { set, unset: ambientUnset(intent) }, args: [...passthrough], warnings }
  },
} satisfies AgentCliPort
