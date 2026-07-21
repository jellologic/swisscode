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
import * as esbuild from 'esbuild'

const TSC = 'node_modules/typescript/bin/tsc'

// Stale output is worse than no output: a module deleted in a migration slice
// would otherwise linger in dist/ and keep resolving.
rmSync('dist', { recursive: true, force: true })

// Stage 1. Emits .js for both .ts and (while the migration is in flight) .js
// sources, rewriting "./x.ts" specifiers to "./x.js" on the way out.
execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { stdio: 'inherit' })

// Stage 2. ink/react stay external so we never have to bundle yoga's wasm.
// esbuild reads the TSX/JSX sources directly and strips types itself — type
// CHECKING is `npm run typecheck`'s job, not the bundler's, so the UI never
// waits on a second tsc pass.
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
  external: ['ink', 'react', 'react/jsx-runtime', 'ink-select-input', 'ink-text-input'],
})

console.log(`built dist/ (tsc) and dist/ui.js (esbuild, from ${uiRoot})`)
