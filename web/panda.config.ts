import { defineConfig } from '@pandacss/dev'

/**
 * The design system.
 *
 * Panda is BUILD-TIME ONLY: it emits static CSS and ships no runtime library,
 * which is why a styling system exists in a project whose whole pitch is four
 * runtime dependencies without changing that number.
 *
 * WHERE THE NUMBERS COME FROM. They are measured, not invented. The type scale,
 * weights, surface ramp and motion are read out of Linear's shipped CSS custom
 * properties on the live site; the light ramp and the tracking curve are read
 * out of Apple's. Two things they agree on, which is what makes a UI read as
 * "clean" far more than any individual colour:
 *
 *   1. NEGATIVE TRACKING THAT SCALES WITH SIZE. Apple runs -0.01em at 12px and
 *      -0.022em at 17px; Linear's display sizes sit around -0.022em. Large text
 *      left at default tracking is the most common tell of an unstyled app.
 *   2. HAIRLINES, NOT SHADOWS, for structure. Linear's cards are a 12px radius
 *      and a 1px translucent border with `box-shadow: none`. Shadows are kept
 *      for things that genuinely float.
 *
 * `strictTokens` IS THE POINT OF THIS FILE. With it on, `color: '#fff'` and
 * `fontSize: '13px'` are TYPE ERRORS: every value in the app must name a token.
 * That is what makes this a design system rather than a palette some components
 * happen to reference — one that nothing enforces decays into arbitrary values
 * within a release, and this codebase already carried twelve distinct hardcoded
 * font sizes before the rule existed.
 */
export default defineConfig({
  preflight: true,
  include: ['./src/**/*.{ts,tsx}'],
  exclude: [],

  // The whole reason this config is worth having. See the note above.
  strictTokens: true,

  /**
   * `data-theme` is stamped on <html> and always holds a RESOLVED value —
   * `light` or `dark`, never `system`. Resolution happens once, before first
   * paint, so there is no flash of the wrong theme and no component ever has to
   * ask which mode it is in.
   */
  conditions: {
    extend: {
      dark: '[data-theme=dark] &',
      light: '[data-theme=light] &',
    },
  },

  theme: {
    extend: {
      tokens: {
        fonts: {
          // No webfont is loaded: a launcher's local config UI must not block
          // paint on a network request, so this uses what the machine has.
          // "Inter Variable" is named first for parity with Linear when present.
          sans: {
            value:
              'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter Variable", "Inter", "SF Pro Text", "Segoe UI", Roboto, sans-serif',
          },
          mono: {
            value: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          },
        },
        fontWeights: {
          // 590 rather than 600: it is what Linear's titles use, and on a
          // variable font it reads as a heading without the heavy-handedness of
          // semibold. Static fonts round it to the nearest weight they have.
          normal: { value: '400' },
          medium: { value: '510' },
          title: { value: '590' },
        },
        radii: {
          xs: { value: '4px' },
          sm: { value: '6px' },
          md: { value: '8px' },
          lg: { value: '12px' },
          full: { value: '9999px' },
        },
        // Linear's three, verbatim. Used almost nowhere, by design.
        shadows: {
          low: { value: '0 2px 4px rgba(0,0,0,0.10)' },
          medium: { value: '0 4px 24px rgba(0,0,0,0.20)' },
          high: { value: '0 7px 32px rgba(0,0,0,0.35)' },
        },
        durations: {
          // 0.1s is Linear's interaction speed: fast enough to read as a state
          // change rather than an animation.
          fast: { value: '0.1s' },
          slow: { value: '0.15s' },
        },
        sizes: {
          // One control height for the whole app. Linear's is 32px.
          control: { value: '32px' },
          controlSm: { value: '26px' },
          sidebar: { value: '208px' },
          content: { value: '46rem' },
        },
      },

      /**
       * Every colour the app may use, in both modes.
       *
       * Components name a ROLE — `surface.panel`, `content.secondary` — never a
       * shade. That is what makes light mode a data change rather than a second
       * set of components, and it is what lets `strictTokens` be on at all.
       */
      semanticTokens: {
        colors: {
          surface: {
            // Apple's off-white, not #fff: a pure-white canvas behind a panel
            // that is also white leaves nothing to see.
            canvas: { value: { base: '#f5f5f7', _dark: '#08090a' } },
            panel: { value: { base: '#ffffff', _dark: '#101112' } },
            raised: { value: { base: '#ffffff', _dark: '#1c1c1f' } },
            hover: { value: { base: '#f0f0f3', _dark: '#232326' } },
            active: { value: { base: '#e8e8ed', _dark: '#28282c' } },
            overlay: { value: { base: 'rgba(0,0,0,0.25)', _dark: 'rgba(0,0,0,0.55)' } },
          },
          content: {
            // #1d1d1f is Apple's near-black, #f7f8f8 Linear's near-white.
            // Neither ships pure black or pure white as text.
            primary: { value: { base: '#1d1d1f', _dark: '#f7f8f8' } },
            secondary: { value: { base: '#515154', _dark: '#d0d6e0' } },
            tertiary: { value: { base: '#86868b', _dark: '#8a8f98' } },
            inverse: { value: { base: '#ffffff', _dark: '#08090a' } },
          },
          border: {
            subtle: { value: { base: 'rgba(0,0,0,0.06)', _dark: 'rgba(255,255,255,0.06)' } },
            default: { value: { base: 'rgba(0,0,0,0.10)', _dark: '#23252a' } },
            strong: { value: { base: 'rgba(0,0,0,0.18)', _dark: '#31333a' } },
          },
          accent: {
            default: { value: { base: '#5e6ad2', _dark: '#7b86e8' } },
            hover: { value: { base: '#4f5bc4', _dark: '#8d97ee' } },
            subtle: { value: { base: 'rgba(94,106,210,0.10)', _dark: 'rgba(123,134,232,0.14)' } },
          },
          // Status colours are DARKER in light mode. The dark-mode green and
          // amber are picked against near-black and fail contrast on white;
          // reusing them is the usual way a light theme ends up illegible.
          ok: {
            default: { value: { base: '#1a7f37', _dark: '#3fb950' } },
            subtle: { value: { base: 'rgba(26,127,55,0.10)', _dark: 'rgba(63,185,80,0.14)' } },
          },
          warn: {
            default: { value: { base: '#9a6700', _dark: '#d29922' } },
            subtle: { value: { base: 'rgba(154,103,0,0.10)', _dark: 'rgba(210,153,34,0.14)' } },
          },
          danger: {
            default: { value: { base: '#cf222e', _dark: '#f85149' } },
            subtle: { value: { base: 'rgba(207,34,46,0.10)', _dark: 'rgba(248,81,73,0.14)' } },
          },
        },
      },

      /**
       * The type scale: Linear's sizes with Apple's tracking curve applied.
       *
       * These are `textStyles` rather than loose font-size tokens because a
       * size without its line-height and tracking is exactly the part that gets
       * forgotten, and the tracking is half of why this looks the way it does.
       */
      textStyles: {
        display: {
          value: {
            fontSize: '28px',
            lineHeight: '1.15',
            fontWeight: '590',
            letterSpacing: '-0.022em',
          },
        },
        title: {
          value: {
            fontSize: '20px',
            lineHeight: '1.3',
            fontWeight: '590',
            letterSpacing: '-0.018em',
          },
        },
        heading: {
          value: {
            fontSize: '15px',
            lineHeight: '1.4',
            fontWeight: '590',
            letterSpacing: '-0.012em',
          },
        },
        body: {
          value: {
            fontSize: '13px',
            lineHeight: '1.5',
            fontWeight: '400',
            letterSpacing: '-0.006em',
          },
        },
        // The workhorse: every secondary line, badge and hint in the app.
        meta: {
          value: {
            fontSize: '12px',
            lineHeight: '1.45',
            fontWeight: '400',
            letterSpacing: '-0.003em',
          },
        },
        micro: {
          value: {
            fontSize: '11px',
            lineHeight: '1.4',
            fontWeight: '400',
            letterSpacing: '0',
          },
        },
        // Monospace never gets negative tracking: it is set to be aligned and
        // counted, and tightening it defeats the reason to reach for it.
        code: {
          value: {
            fontFamily: 'mono',
            fontSize: '12px',
            lineHeight: '1.5',
            letterSpacing: '0',
          },
        },
      },
    },
  },

  outdir: 'styled-system',
  jsxFramework: 'react',
})
