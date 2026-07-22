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
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
