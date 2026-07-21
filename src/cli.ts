import { parseArgv } from './core/args.ts'
import { defaultDeps, LaunchError, main } from './composition/launch-root.ts'
import type { Profile, State } from './ports/config-store.ts'

/**
 * Which wizard to open.
 *
 * Spelled here rather than imported from ./composition/config-root.ts, for the
 * same reason config-root spells `OpenUi` locally instead of importing it from
 * adapters/ui: a static `import type` of config-root would put that module into
 * the launch path's SOURCE graph, and the architecture test that keeps the
 * config subcommands off the launch path reads the source graph.
 *
 * The duplication is CHECKED, not blind. `openUi` is handed to
 * `runConfigCommand` below, so if this union ever drifts from config-root's
 * `WizardMode` the call stops compiling.
 */
type WizardMode = 'config' | 'setup'

/**
 * The slice of dist/ui.js this module uses.
 *
 * SPELLED STRUCTURALLY, naming no UI module — and that is not fussiness, it is
 * a packaging requirement discovered the hard way. Writing this as
 * `typeof import('./composition/ui-root.ts')` also compiles, also erases, and
 * also keeps the launch path clean at runtime… and then silently ships the
 * entire React component tree a SECOND time, unbundled, as
 * dist/adapters/ui/*.js.
 *
 * The reason: tsconfig.build.json `exclude`s src/adapters/ui, but `exclude`
 * only filters the `include` globs. A module reached through an IMPORT — even a
 * type-only query like the one above — still joins the program, and being under
 * rootDir it is still emitted. So the exclusion silently stops applying the
 * moment anything under src/ names the UI, in type space or otherwise.
 *
 * Declaring the shape here instead is the same move config-root.ts makes with
 * `OpenUi`, for the same reason. It is not an unchecked guess either:
 * test/ports.conformance.ts asserts the REAL ui-root satisfies this type, and
 * test/ is never emitted, so that check costs the package nothing.
 */
export type UiModule = {
  runUi: (options: {
    mode: WizardMode
    state: State
    profileName?: string | null
  }) => Promise<Profile | null>
}

/**
 * The Ink UI is imported lazily and only from here. bin/cuckoocode.js and
 * everything the launch path reaches stays plain dependency-free JS, so a
 * normal launch never pays for loading React.
 *
 * `profileName` is optional here but required by config-root's `OpenUi`, which
 * is the correct direction: a handler may accept more than the contract
 * promises to pass. runCli's own `openUi('setup', …)` call relies on it.
 */
async function openUi(
  mode: WizardMode,
  options: { state: State; profileName?: string | null },
): Promise<Profile | null> {
  let ui: UiModule
  try {
    // @ts-expect-error '../dist/ui.js' is BUILD OUTPUT, not source, and tsc
    // must never resolve it: that would make `npm run typecheck` depend on
    // build order and would typecheck the compiler's own emit. The contract
    // this import has to honour is `UiModule` above, which is checked against
    // the real source instead.
    ui = await import('../dist/ui.js')
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('UI bundle is missing. Run `npm run build` in the cuckoocode checkout.')
    }
    throw err
  }
  return ui.runUi({ mode, ...options })
}

/**
 * `never`, because every path leaves: a LaunchError exits with its own code and
 * anything else is rethrown. Declaring it is what lets `runCli` treat `planned`
 * as assigned after the try/catch below — without it tsc reports a
 * possibly-undefined read on the very next line.
 */
function fail(err: unknown): never {
  if (err instanceof LaunchError) {
    console.error(`cuckoocode: ${err.message}`)
    process.exit(err.exitCode)
  }
  throw err
}

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseArgv(argv)

  // An unknown --cc-* option, a --cc-model with a bad tier, a repeated
  // --cc-profile. Exit 2 rather than forwarding a reserved-prefix token to
  // claude, where it would read as prompt text while the launch silently used
  // the wrong settings.
  if (parsed.error) {
    console.error(`cuckoocode: ${parsed.error}`)
    process.exit(2)
  }

  const { command, commandArgs, passthrough, skipOverride, positional, profileFlag, overrides } = parsed

  if (command) {
    // Subcommand dispatch is lazily imported so the launch path's static
    // closure never carries it.
    const { runConfigCommand } = await import('./composition/config-root.ts')
    const code = await runConfigCommand({
      command,
      args: commandArgs,
      deps: defaultDeps(),
      openUi,
    })
    if (code !== 0) process.exit(code)
    return
  }

  const launchArgs = { passthrough, skipOverride, positional, profileFlag, overrides }

  let planned
  try {
    planned = main({ ...launchArgs, deps: defaultDeps() })
  } catch (err) {
    fail(err)
  }

  // Nothing below runs on a successful launch: execve replaced this process,
  // and the spawn fallback ends in an exit relay.
  if (!planned?.needsSetup) return

  if (planned.selection.ambiguous) {
    const names = Object.keys(planned.loaded.state.profiles).join(', ')
    console.error(
      'cuckoocode: several profiles exist and none is set as the default. ' +
        `Run \`cuckoocode config default <name>\` to choose one. Profiles: ${names}`,
    )
    process.exit(2)
  }

  const saved = await openUi('setup', { state: planned.loaded.state })
  if (!saved) {
    console.error('cuckoocode: setup cancelled, nothing launched.')
    process.exit(1)
  }

  // Re-read from disk so the launch uses exactly what was persisted.
  try {
    main({ ...launchArgs, deps: defaultDeps() })
  } catch (err) {
    fail(err)
  }
}
