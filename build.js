// One compile stage, plus the optional web frontend.
//
//   1. tsc  src/**  -> dist/**   plain compiled JS
//   2. vite web/    -> dist/web  the browser control plane (optional)
//
// There is no bundler over `dist/`: the launch path stays a readable, auditable
// tree of individual modules. The esbuild stage that produced dist/ui.js went
// with the Ink wizard — configuration is done in the browser now, so the only
// bundled artifact is the one the browser loads.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

console.log(`built dist/ (tsc)` + (webBuilt ? ' and dist/web (vite)' : ''))
