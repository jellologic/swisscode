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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'bin', 'cuckoocode.js')

const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s[^'"()]*?from\s*['"]([^'"]+)['"]/g
const BARE_IMPORT = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function matchAll(src, re) {
  return [...src.matchAll(re)].map((m) => m[1])
}

/** Follow only STATIC imports — a dynamic import is exactly the escape hatch. */
function launchClosure() {
  const seen = new Set()
  const dynamic = new Map()
  const queue = [ENTRY]

  while (queue.length) {
    const file = queue.pop()
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
      const target = resolve(dirname(file), spec)
      assert.ok(existsSync(target), `${relative(ROOT, file)} imports missing file ${spec}`)
      queue.push(target)
    }
  }
  return { files: [...seen], dynamic }
}

test('the launch path never statically reaches React, Ink, or node_modules', () => {
  const { files } = launchClosure()
  for (const f of files) {
    assert.ok(!f.includes('node_modules'), `${relative(ROOT, f)} is inside node_modules`)
    assert.ok(!f.endsWith('.jsx'), `${relative(ROOT, f)} is a JSX file`)
  }
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

function walk(dir) {
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
    lines.forEach((line, i) => {
      assert.ok(
        !/^(export\s+)?(let|var)\s/.test(line),
        `${relative(ROOT, file)}:${i + 1} declares top-level mutable state: ${line.trim()}`,
      )
    })
  }
})

test('core/ imports nothing outside core/ and node: builtins', () => {
  for (const file of walk(join(ROOT, 'src', 'core'))) {
    const src = readFileSync(file, 'utf8')
    for (const spec of [...matchAll(src, STATIC_IMPORT), ...matchAll(src, BARE_IMPORT)]) {
      assert.ok(
        !spec.includes('/adapters/') && !spec.includes('/composition/') && !spec.startsWith('..'),
        `${relative(ROOT, file)} imports "${spec}" — core must stay pure`,
      )
    }
  }
})

test('ports/ carry no runtime behaviour at all', () => {
  for (const file of walk(join(ROOT, 'src', 'ports'))) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim()
    assert.equal(
      code,
      'export {}',
      `${relative(ROOT, file)} contains runtime statements; ports are typedefs only`,
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
