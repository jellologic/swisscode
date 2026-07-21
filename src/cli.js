import { CONFIG_PATH, loadConfig } from './config.js'
import { launch } from './launch.js'

// Deliberately tiny. Every other token is Claude Code's to interpret, so the
// wrapper stays a drop-in replacement instead of a competing arg parser.
const CONFIG_COMMANDS = new Set(['config', 'setup'])

function parse(argv) {
  const passthrough = []
  let skipOverride = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // After a bare `--`, everything belongs to Claude Code verbatim.
    if (arg === '--') {
      passthrough.push(...argv.slice(i))
      break
    }
    if (arg === '--safe') {
      skipOverride = false
      continue
    }
    if (arg === '--yolo') {
      skipOverride = true
      continue
    }
    passthrough.push(arg)
  }

  return { passthrough, skipOverride }
}

async function openUi(mode, initial) {
  let ui
  try {
    ui = await import('../dist/ui.js')
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('UI bundle is missing. Run `npm run build` in the cuckoocode checkout.')
    }
    throw err
  }
  return ui.runUi({ mode, initial })
}

export async function runCli(argv) {
  if (argv.length > 0 && CONFIG_COMMANDS.has(argv[0])) {
    const saved = await openUi('config', loadConfig())
    if (saved) console.log(`\n  saved to ${CONFIG_PATH}\n`)
    return
  }

  const { passthrough, skipOverride } = parse(argv)

  let cfg = loadConfig()
  if (!cfg) {
    cfg = await openUi('setup', null)
    if (!cfg) {
      console.error('cuckoocode: setup cancelled, nothing launched.')
      process.exit(1)
    }
  }

  launch(cfg, passthrough, skipOverride)
}
