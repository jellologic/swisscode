import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Builds the SPA into dist/web, which swisscode's own node:http server then
 * serves. There is no Vite server in production and no SSR: the API is
 * swisscode's, the security gate is swisscode's, and this is a static bundle.
 *
 * `base: './'` so the assets resolve regardless of where the server mounts
 * them, and no hashed-directory assumptions leak into the HTML.
 */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  /**
   * React's API, Preact's runtime — A BUILD-TIME SUBSTITUTION ONLY.
   *
   * react-dom is 168 kB of the bundle this server ships, and this page uses
   * almost none of what that buys: seven screens, `useState`/`useEffect`/
   * `useMemo`/`useCallback`, no concurrent rendering, no suspense, no server
   * components. 237.9 kB became 69.8 kB.
   *
   * The source still imports `react` and still typechecks against
   * `@types/react` — the alias exists here, at the bundler, so nothing in
   * `web/src` has to know. Reverting is deleting this block.
   *
   * NOT related to the `react` in `dependencies`. That one is Ink's, it renders
   * the TERMINAL wizard, and it is untouched by any of this.
   */
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
