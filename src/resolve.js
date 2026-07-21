import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))

function isExecutableFile(p) {
  try {
    const s = statSync(p)
    return s.isFile() && (s.mode & 0o111) !== 0
  } catch {
    return false
  }
}

// Guard against `alias claude=cuckoocode` (or a global shim pointing back at
// us), which would otherwise recurse until the machine gives up.
function isSelf(p) {
  try {
    return realpathSync(p).startsWith(`${SELF_DIR}/`)
  } catch {
    return false
  }
}

const FALLBACKS = [
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), '.claude', 'local', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
]

export function resolveClaude() {
  const override = process.env.CUCKOOCODE_CLAUDE_BIN
  if (override) {
    if (isExecutableFile(override)) return override
    throw new Error(
      `CUCKOOCODE_CLAUDE_BIN is set to "${override}", which is not an executable file.`,
    )
  }

  // PATH order is intentional: inside a wrapper environment (cmux, devcontainer
  // shims) the earlier entry is the one that env expects to be used.
  let skippedSelf = false
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'claude')
    if (!isExecutableFile(candidate)) continue
    if (isSelf(candidate)) {
      skippedSelf = true
      continue
    }
    return candidate
  }

  for (const candidate of FALLBACKS) {
    if (isExecutableFile(candidate) && !isSelf(candidate)) return candidate
  }

  throw new Error(
    skippedSelf
      ? 'the only `claude` on your PATH is cuckoocode itself. Point CUCKOOCODE_CLAUDE_BIN at the real binary.'
      : 'could not find the `claude` binary on your PATH. Install Claude Code, or set CUCKOOCODE_CLAUDE_BIN.',
  )
}
