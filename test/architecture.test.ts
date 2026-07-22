// Guards the one architectural property this project actually sells: launching
// Claude Code must not load React.
//
// Deterministic by construction — it asserts on the import graph, not on
// wall-clock startup time, so it cannot flake on a loaded CI box.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

// stripTypeScriptTypes is flagged experimental and prints a warning on first
// use. Node runs each test file in its own process, so this filter is scoped to
// this file and hides exactly that one warning — nothing else.
const emitWarning = process.emitWarning
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('stripTypeScriptTypes')) return
  // Cast: emitWarning has four overloads and this forwards all of them
  // verbatim, which no single signature expresses.
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest)
}) as typeof process.emitWarning

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Source imports spell `.ts`/`.tsx`; a missing file is reported as such. */
function onDisk(p: string): string | null {
  return existsSync(p) ? p : null
}

/**
 * The launch path is a property of the SOURCE graph, so the closure is rooted
 * at the real launch module rather than at bin/. bin/swisscode.js is a
 * deliberately trivial shim over the compiled output; it is pinned by its own
 * test below, which is strictly more specific than walking through it.
 */
const ENTRY = onDisk(join(ROOT, 'src', 'cli.ts'))

const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s[^'"()]*?from\s*['"]([^'"]+)['"]/g
const BARE_IMPORT = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function matchAll(src: string, re: RegExp): string[] {
  return [...src.matchAll(re)].map((m) => m[1]!)
}

/** Follow only STATIC imports — a dynamic import is exactly the escape hatch. */
function launchClosure(): { files: string[]; dynamic: Map<string, string> } {
  const seen = new Set<string>()
  const dynamic = new Map<string, string>()
  // ENTRY is asserted non-null at module scope below; a null here would mean
  // src/cli.* does not exist, which is a different failure entirely.
  const queue: string[] = [ENTRY!]

  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')

    for (const spec of matchAll(src, DYNAMIC_IMPORT)) {
      dynamic.set(spec, file)
    }

    for (const spec of [...matchAll(src, STATIC_IMPORT), ...matchAll(src, BARE_IMPORT)]) {
      if (spec.startsWith('node:')) continue
      assert.ok(
        spec.startsWith('.') || spec.startsWith('/'),
        `${relative(ROOT, file)} statically imports "${spec}" — the launch path must ` +
          'resolve everything inside src/ or node: builtins.',
      )
      const target = onDisk(resolve(dirname(file), spec))
      assert.ok(target, `${relative(ROOT, file)} imports missing file ${spec}`)
      queue.push(target)
    }
  }
  return { files: [...seen], dynamic }
}

test('the launch path never statically reaches React, Ink, or node_modules', () => {
  const { files } = launchClosure()
  for (const f of files) {
    assert.ok(!f.includes('node_modules'), `${relative(ROOT, f)} is inside node_modules`)
    assert.ok(!/\.(jsx|tsx)$/.test(f), `${relative(ROOT, f)} is a JSX file`)
  }
})

test('the published bin shim is dependency-free and runs compiled output', () => {
  // bin/ is what npm installs as `swisscode`. It must stay plain JS with no
  // imports of its own beyond the compiled entry, so the published package
  // never depends on Node's native type stripping (engines is ">=22", where
  // stripping is not reliably enabled).
  const shim = join(ROOT, 'bin', 'swisscode.js')
  const src = readFileSync(shim, 'utf8')
  const specs = [
    ...matchAll(src, STATIC_IMPORT),
    ...matchAll(src, BARE_IMPORT),
    ...matchAll(src, DYNAMIC_IMPORT),
  ]
  assert.deepEqual(
    specs,
    ['../dist/cli.js'],
    'bin/swisscode.js must import exactly the compiled CLI entry and nothing else',
  )
})

test('the launch path never statically reaches adapters/ui or adapters/catalog', () => {
  const { files } = launchClosure()
  for (const f of files) {
    const rel = relative(ROOT, f)
    assert.ok(!rel.startsWith('src/adapters/ui'), `${rel} is a UI adapter`)
    assert.ok(!rel.startsWith('src/adapters/catalog'), `${rel} is a catalog adapter`)
  }
})

test('the UI bundle is reachable only through a dynamic import', () => {
  const { files, dynamic } = launchClosure()
  assert.ok(
    [...dynamic.keys()].some((s) => s.includes('dist/ui.js')),
    'nothing on the launch path lazily imports the UI bundle',
  )
  for (const f of files) {
    assert.ok(!f.includes(join('dist', 'ui.js')), 'dist/ui.js is in the static closure')
  }
})

test('the launch path is small enough to keep auditing by hand', () => {
  const { files } = launchClosure()
  assert.ok(files.length < 30, `launch path has grown to ${files.length} modules`)
})

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

test('core/ is stateless: no top-level let or var', () => {
  // dist/ui.js inlines its own copy of core/. Two copies in one process are
  // harmless only while the core holds no mutable module state.
  for (const file of walk(join(ROOT, 'src', 'core'))) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line: string, i: number) => {
      assert.ok(
        !/^(export\s+)?(let|var)\s/.test(line),
        `${relative(ROOT, file)}:${i + 1} declares top-level mutable state: ${line.trim()}`,
      )
    })
  }
})

test('core/ imports nothing outside core/ and node: builtins', () => {
  // Asserted against the POST-ERASURE program, not the source text.
  //
  // core/ now imports its shapes from ports/ with `import type`, which is a
  // compile-time-only edge: under verbatimModuleSyntax a type-only import
  // provably emits nothing, so it cannot make core depend on ports at runtime.
  // The old source-text version of this test rejected any ".." specifier and
  // so would have failed on those, while a REGEX cannot reliably tell
  // `import type {X} from` from `import {X} from`.
  //
  // Erasing first is strictly stronger than either: it checks the actual
  // program core/ becomes. A real runtime import of a port still appears and
  // still fails, and so does a MIXED import (`import {type A, b} from`) —
  // verified, because that one keeps a live binding and is therefore a genuine
  // runtime edge.
  const files = walk(join(ROOT, 'src', 'core'))
  assert.ok(files.length > 0, 'no core files found; the walk is looking in the wrong place')
  for (const file of files) {
    const src = runtimeResidue(file)
    for (const spec of [...matchAll(src, STATIC_IMPORT), ...matchAll(src, BARE_IMPORT)]) {
      assert.ok(
        !spec.includes('/adapters/') && !spec.includes('/composition/') && !spec.startsWith('..'),
        `${relative(ROOT, file)} imports "${spec}" at RUNTIME — core must stay pure`,
      )
    }
  }
})

/**
 * Everything a file still contains once its TYPES have been erased.
 *
 * Ports are now .ts, so the old "strip comments and compare" check would see a
 * page of `export type` declarations and fail — but loosening it to allow those
 * by pattern would be weaker than what it replaced, because a regex cannot tell
 * `export type X = ...` from `export const x = ...` reliably enough to be worth
 * trusting with this property.
 *
 * Erasing the types instead makes the assertion STRONGER than the original: it
 * checks the actual post-erasure program rather than pattern-matching the
 * source, so it proves both that the file is type-only AND that it is fully
 * erasable — the property `erasableSyntaxOnly` and the no-build test loop both
 * depend on.
 */
function runtimeResidue(file: string): string {
  const src = readFileSync(file, 'utf8')
  const erased = file.endsWith('.ts') || file.endsWith('.tsx')
    ? stripTypeScriptTypes(src, { mode: 'strip' })
    : src
  return erased
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim()
}

test('ports/ carry no runtime behaviour at all', () => {
  const files = walk(join(ROOT, 'src', 'ports'))
  assert.ok(files.length > 0, 'no port files found; the walk is looking in the wrong place')
  for (const file of files) {
    assert.equal(
      runtimeResidue(file),
      'export {}',
      `${relative(ROOT, file)} contains runtime statements; ports must be type-only`,
    )
  }
})

test('no source file references the modules Phase Core deleted', () => {
  const stale = ['src/providers.js', 'src/launch.js', 'src/config.js', 'src/models.js', 'src/resolve.js']
  for (const p of stale) {
    assert.ok(!existsSync(join(ROOT, p)), `${p} still exists; the shim was not removed`)
  }
})

test('the config subcommands and the doctor stay off the launch path', () => {
  // Neither is needed to launch, and the doctor reaches the network. Both are
  // behind dynamic imports for the same reason the UI bundle is.
  const { files, dynamic } = launchClosure()
  for (const f of files) {
    const rel = relative(ROOT, f)
    assert.ok(!rel.includes('config-root'), `${rel} is in the static launch closure`)
    assert.ok(!rel.includes('doctor'), `${rel} is in the static launch closure`)
  }
  assert.ok(
    [...dynamic.keys()].some((s) => s.includes('config-root')),
    'nothing on the launch path lazily imports the config subcommands',
  )
})

test('nothing on the launch path can reach fetch, a socket, or a subprocess it did not exec', () => {
  // A launcher must not make network calls. execve/spawn in the process adapter
  // is the one deliberate exception.
  const { files } = launchClosure()
  for (const f of files) {
    const rel = relative(ROOT, f)
    const src = readFileSync(f, 'utf8')
    for (const spec of [...matchAll(src, STATIC_IMPORT), ...matchAll(src, BARE_IMPORT)]) {
      if (!spec.startsWith('node:')) continue
      assert.ok(
        !['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram'].includes(spec),
        `${rel} imports ${spec} on the launch path`,
      )
    }
    if (rel.includes('node-process')) continue
    assert.ok(!/\bfetch\s*\(/.test(src), `${rel} calls fetch on the launch path`)
  }
})
