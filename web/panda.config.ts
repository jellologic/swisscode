import { defineConfig } from '@pandacss/dev'

/**
 * Panda is BUILD-TIME ONLY: it emits static CSS and ships no runtime library,
 * which is why a styling system could be added to a project whose whole pitch
 * is four runtime dependencies without changing that number.
 *
 * The token set below is the "Linear" look, and it is mostly restraint: a
 * near-black surface ramp, hairline borders doing the structural work instead
 * of shadows, a three-step text hierarchy, and colour reserved for status.
 */
export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,tsx}'],
  exclude: [],
  // No dark VARIANT: this UI is dark, full stop. A theme toggle nobody asked
  // for is two code paths to keep honest.
  theme: {
    extend: {
      tokens: {
        colors: {
          // surfaces, darkest first
          bg: { value: '#0c0d10' },
          panel: { value: '#101116' },
          raised: { value: '#16181d' },
          hover: { value: '#1b1e24' },
          // hairlines
          line: { value: '#22252c' },
          lineStrong: { value: '#2e323b' },
          // text, three steps and no more
          text: { value: '#e7e8ea' },
          dim: { value: '#9ba1ac' },
          faint: { value: '#6b7280' },
          // status, used sparingly
          accent: { value: '#5e6ad2' },
          accentHover: { value: '#6e79db' },
          ok: { value: '#3fb950' },
          warn: { value: '#d29922' },
          danger: { value: '#f85149' },
        },
        radii: {
          sm: { value: '4px' },
          md: { value: '6px' },
          lg: { value: '8px' },
        },
        fonts: {
          sans: {
            value:
              'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
          },
          mono: { value: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace' },
        },
      },
      semanticTokens: {
        colors: {
          border: { value: '{colors.line}' },
        },
      },
    },
  },
  outdir: 'styled-system',
  jsxFramework: 'react',
})
