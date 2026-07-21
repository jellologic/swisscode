import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'cuckoocode',
)
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return cfg && typeof cfg.provider === 'string' ? cfg : null
  } catch {
    return null
  }
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync's mode only applies on create, so re-assert it for files that
  // already existed with looser permissions. This file holds an API key.
  chmodSync(CONFIG_PATH, 0o600)
  return CONFIG_PATH
}
