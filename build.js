import * as esbuild from 'esbuild'

// Only the Ink UI gets bundled. ink/react stay external so we never have to
// bundle yoga's wasm, and the launch path (bin/ + src/*.js) stays plain Node
// with zero imports — that path must not pay for loading React.
await esbuild.build({
  entryPoints: ['src/ui/index.jsx'],
  outfile: 'dist/ui.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  external: ['ink', 'react', 'react/jsx-runtime', 'ink-select-input', 'ink-text-input'],
})

console.log('built dist/ui.js')
