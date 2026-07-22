// Two-stage build. Neither stage is optional.
//
//   1. tsc  src/**            -> dist/**      plain compiled JS, the launch path
//   2. esbuild ui-root        -> dist/ui.js   the bundled Ink UI
//
// They are separate because they ship different things. The launch path must
// stay a readable, auditable tree of individual modules with no bundler in the
// way. The UI is one lazily-imported blob that nothing on the launch path is
// allowed to reach.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as esbuild from 'esbuild'

const TSC = 'node_modules/typescript/bin/tsc'

/**
 * Find a workspace tool, WHEREVER THE INSTALLER PUT IT.
 *
 * `web` is a workspace now, and npm and bun do not agree on where its
 * dependencies land: npm usually hoists them to the root `node_modules`, bun
 * may leave them in `web/node_modules`, and either can change its mind when a
 * version conflict forces nesting. Hard-coding one path made the build work
 * under one package manager and fail under the other, which is exactly the
 * "works on my machine" this project runs two runtimes to avoid.
 */
function workspaceTool(relative) {
  for (const base of ['web/node_modules', 'node_modules']) {
    const candidate = join(base, relative)
    if (existsSync(candidate)) return resolve(candidate)
  }
  return null
}

// Stale output is worse than no output: a deleted module would otherwise linger
// in dist/ and keep resolving.
rmSync('dist', { recursive: true, force: true })

// Stage 1. tsc emits plain JS from TypeScript sources, rewriting "./x.ts"
// specifiers to "./x.js" on the way out.
execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { stdio: 'inherit' })

// The type-only ports erase to `export {}` and are imported only with
// `import type`, so no compiled module ever loads dist/ports/*.js. tsc still
// emits them (an import type re-adds a file to the program even when `exclude`d),
// so drop them here rather than ship nine inert stubs in the tarball.
rmSync('dist/ports', { recursive: true, force: true })

// Stage 2. ink/react stay external so we never have to bundle yoga's wasm.
// esbuild reads the TSX sources and strips types; type CHECKING is
// `pnpm typecheck`'s job, not the bundler's.
const uiRoot = 'src/composition/ui-root.ts'
if (!existsSync(uiRoot)) throw new Error(`build: cannot find ${uiRoot}`)

await esbuild.build({
  entryPoints: [uiRoot],
  outfile: 'dist/ui.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  // Minified, unlike stage 1's output. This one is already a single opaque
  // blob that nothing on the launch path may reach and no human reads module by
  // module, so the auditability argument that keeps `dist/` unbundled does not
  // apply to it — and it halves, 74.5 kB to 38.2 kB.
  minify: true,
  external: ['ink', 'react', 'react/jsx-runtime', 'ink-select-input', 'ink-text-input'],
})

// Stage 3. The web UI, built by Vite into dist/web.
//
// Its whole toolchain — vite, react-dom, Panda — is a devDependency and none of
// it ships: `files` is bin/dist/README, so users receive the emitted assets and
// nothing that produced them. The runtime dependency count is unchanged.
//
// Skipped when the toolchain is absent so `npm ci --omit=dev` and a published
// tarball rebuild both still work; the server falls back to a page that says so
// rather than 404ing.
const webRoot = 'web'
let webBuilt = false
const panda = workspaceTool('@pandacss/dev/bin.js')
const vite = workspaceTool('vite/bin/vite.js')
if (panda && vite) {
  // Panda is CODEGEN, and it has to run before Vite: the generated
  // styled-system/ is what the app imports, and its PostCSS plugin is what
  // fills the @layer declarations. Skipping it produces a build that succeeds
  // and a page that renders completely unstyled.
  execFileSync(process.execPath, [panda, 'codegen', '--config', 'panda.config.ts'], {
    cwd: webRoot,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [vite, 'build'], { cwd: webRoot, stdio: 'inherit' })
  webBuilt = true
} else {
  console.log('skipped dist/web (frontend toolchain not installed)')
}

console.log(
  `built dist/ (tsc), dist/ui.js (esbuild, from ${uiRoot})` +
    (webBuilt ? ' and dist/web (vite)' : ''),
)
