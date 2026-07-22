// The OpenCode adapter (opencode-ai, binary `opencode`).
//
// OpenCode reads a full config inline from OPENCODE_CONFIG_CONTENT (highest
// precedence, no file written), selects a model as `provider/model`, and
// auto-approves with `--auto` (documented for both the TUI and `run`). It has a
// main model plus a `small_model`, so the profile's opus tier drives the main
// model and haiku drives the small one; the other tiers warn rather than vanish.
//
// SCHEMA CONSTANTS — verified against https://opencode.ai/docs/config and
// /docs/providers; isolated so any drift is a one-line fix caught by the test.

import { join } from 'node:path'
import {
  ANTHROPIC_SDK_NPM,
  PROVIDER_KEY,
  anthropicOptions,
  collapsedTierWarning,
  extendedContextWarning,
  modelRef,
  modelsBlock,
} from '../shared.ts'
import type { AgentCliPort, EnvWarning, TranslateInput, Translation } from '../../../ports/agent.ts'
import type { AgentBinarySpec } from '../../../ports/process.ts'

/** Env var OpenCode reads an inline config from (highest precedence). */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'
/** Flag that auto-approves permissions not explicitly denied. */
export const OPENCODE_AUTO_FLAG = '--auto'
/** The JSON schema URL OpenCode configs carry. */
export const OPENCODE_SCHEMA = 'https://opencode.ai/config.json'

const binary: AgentBinarySpec = {
  name: 'opencode',
  overrideEnv: 'SWISSCODE_OPENCODE_BIN',
  fallbacks: (home: string) => [
    join(home, '.local', 'bin', 'opencode'),
    join(home, '.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ],
}

export const opencode = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: {
    models: 'primary+small',
    skipPermissions: true,
    extendedContextSuffix: false,
    compatFlags: false,
  },
  binary,
  translate(input: TranslateInput): Translation {
    const { intent, passthrough } = input
    const primary = intent.models.opus
    const small = intent.models.haiku

    const config: Record<string, unknown> = {
      $schema: OPENCODE_SCHEMA,
      provider: {
        [PROVIDER_KEY]: {
          npm: ANTHROPIC_SDK_NPM,
          name: PROVIDER_KEY,
          options: anthropicOptions(intent),
          models: modelsBlock([primary, small]),
        },
      },
    }
    if (primary) config.model = modelRef(primary)
    if (small && small !== primary) config.small_model = modelRef(small)

    const set: Record<string, string> = { [OPENCODE_CONFIG_ENV]: JSON.stringify(config) }
    const args =
      intent.skipPermissions && !passthrough.includes(OPENCODE_AUTO_FLAG)
        ? [OPENCODE_AUTO_FLAG, ...passthrough]
        : [...passthrough]

    const warnings: EnvWarning[] = []
    const collapse = collapsedTierWarning(intent, ['opus', 'haiku'], 'OpenCode')
    if (collapse) warnings.push(collapse)
    const ext = extendedContextWarning(intent, primary, 'OpenCode')
    if (ext) warnings.push(ext)

    return { plan: { set, unset: [] }, args, warnings }
  },
} satisfies AgentCliPort
