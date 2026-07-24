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
   * NO `jsxFramework`, deliberately.
   *
   * Nothing in `web/src` imports `styled-system/jsx` — every style in the app
   * goes through `css()`, `cva()` or `cx()`, which are extracted from the CALL,
   * not from the element. Turning the JSX extractor on as well makes Panda read
   * the props of every capitalised component as style props, and it cannot tell
   * this app's components from its own: `<SegmentedControl fill>` emitted a
   * literal `.fill_true{fill:true}` rule, and `<Stack align="start">` was read
   * as Panda's built-in `stack` PATTERN and emitted an `.ai_start` nobody wears.
   * Both were invalid or dead bytes in the shipped stylesheet, and both would
   * come back the moment a component gained a prop named after a CSS property.
   */

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
        borderWidths: {
          hairline: { value: '1px' },
          // The rule beside a doctor finding. Thicker than a hairline because it
          // is a MARKER rather than an edge — it says which block this is.
          marker: { value: '2px' },
        },
        /**
         * THE APP'S STRUCTURAL DEVICE, AS ONE VALUE — including its colour.
         *
         * The colour rides INSIDE the token, and that is not tidiness. Panda
         * emits every atomic class into one flat `@layer utilities` at equal
         * specificity, in EXTRACTION order, so `borderBottom: '[1px solid]'`
         * paired with a separate `borderColor: 'border.subtle'` is a race:
         * `border-bottom` is a shorthand, omitting the colour resets
         * `border-bottom-color` to `currentColor`, and whichever class the
         * scanner happened to reach last wins. It shipped that way — every
         * panel header, list separator and sidebar divider painted in the TEXT
         * colour instead of a 6%-alpha hairline, at roughly sixteen times the
         * intended contrast, while the visually identical `borderRight` two
         * lines away was correct purely because of where it landed in the file.
         * A type checker cannot see that; one token that carries width, style
         * and colour together removes the race rather than reordering it.
         *
         * Where the colour VARIES with a variant — a button, a chip, a status
         * rule — the recipe sets `borderWidth`/`borderStyle` longhands instead
         * and lets `borderColor` do its job. Longhands do not reset anything, so
         * that composition is order-independent too. What must never appear
         * again is a border SHORTHAND next to a separate `borderColor`.
         */
        borders: {
          hairline: { value: '1px solid {colors.border.subtle}' },
          default: { value: '1px solid {colors.border.default}' },
          strong: { value: '1px solid {colors.border.strong}' },
        },
        /**
         * Two layers, and there are only two: a column header that stays put
         * inside its own scroller, and the one dialog. A raw `z-index: 10` next
         * to a raw `z-index: 1` is not a stacking order, it is two guesses that
         * have not collided yet — and Panda leaves the category unconstrained
         * until something is declared in it, so the numbers were unenforced.
         */
        zIndex: {
          sticky: { value: 1 },
          modal: { value: 10 },
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
          // The label column of a `KeyValueList`. Every label sharing one
          // column is what gives a description block a straight left edge for
          // its values, and a ragged left edge is the single thing that most
          // reads as "unstyled". 8rem clears the longest label these screens
          // use ("Session directory") at `meta` size.
          keyColumn: { value: '8rem' },
          // A search or filter box in a `Toolbar`. `inputStyle` is 100% wide
          // because a field inside a `Field` should fill its row; a search box
          // that did the same would span the page and read as a form input
          // rather than as a control sitting next to buttons.
          search: { value: '18rem' },
          // The app shell's main column — the widest anything gets. It is a
          // skeleton dimension exactly like `sidebar`, and leaving it inline in
          // App.tsx meant the one number `Note`'s own comment cites ("a 58rem
          // line is unreadable") was defined in a file that comment cannot see.
          main: { value: '58rem' },
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
            /**
             * RE-DERIVED FOR LIGHT, the same exercise the status colours below
             * document — and the one that was missed.
             *
             * Apple's #86868b is a caption colour for large type. At the 11-13px
             * this app sets it at, WCAG asks for 4.5:1 and it delivered 3.62 on
             * a white panel, 3.33 on the canvas and 3.19 on a hover tint: every
             * `KeyValue` label, every input placeholder, every page subtitle and
             * every unselected segment failed, on all seven screens. #6d6d72 is
             * the same hue scaled down until the WORST surface clears — 4.52 on
             * surface.hover, 4.73 on canvas, 5.15 on panel.
             *
             * The dark value is left exactly as it is: it already measures
             * 4.82-6.13 against its own surfaces. Light was the broken half.
             */
            tertiary: { value: { base: '#6d6d72', _dark: '#8a8f98' } },
            inverse: { value: { base: '#ffffff', _dark: '#08090a' } },
          },
          border: {
            subtle: { value: { base: 'rgba(0,0,0,0.06)', _dark: 'rgba(255,255,255,0.06)' } },
            default: { value: { base: 'rgba(0,0,0,0.10)', _dark: '#23252a' } },
            strong: { value: { base: 'rgba(0,0,0,0.18)', _dark: '#31333a' } },
          },
          /**
           * The light values are the accent scaled to 0.865, not a different
           * indigo. `accent.subtle` is a 10% wash of the same colour, so an
           * accent-on-accent.subtle chip is a colour sitting on a tenth of
           * itself — a pairing that starts at roughly 3.8:1 and does not care
           * how saturated the hue is. Scaling both together buys the whole set
           * back: 4.75 for the pressed filter chip on the canvas, 5.16 for the
           * "default" badge on a panel, 5.90 for a white label on the filled
           * primary button. `hover` is scaled by the same factor so it stays
           * DARKER than `default` — a hover that lightens the fill in light mode
           * reads as the button going away.
           */
          accent: {
            default: { value: { base: '#525cb5', _dark: '#7b86e8' } },
            hover: { value: { base: '#444faa', _dark: '#8d97ee' } },
            subtle: { value: { base: 'rgba(82,92,181,0.10)', _dark: 'rgba(123,134,232,0.14)' } },
          },
          // Status colours are DARKER in light mode. The dark-mode green and
          // amber are picked against near-black and fail contrast on white;
          // reusing them is the usual way a light theme ends up illegible. The
          // light values here are trimmed a further step from the first pass,
          // because a `Badge` sets them on their own `subtle` wash rather than
          // on the panel — 4.43 and 4.29 measured, where 4.5 is the bar.
          ok: {
            default: { value: { base: '#1a7d36', _dark: '#3fb950' } },
            subtle: { value: { base: 'rgba(26,125,54,0.10)', _dark: 'rgba(63,185,80,0.14)' } },
          },
          warn: {
            default: { value: { base: '#956300', _dark: '#d29922' } },
            subtle: { value: { base: 'rgba(149,99,0,0.10)', _dark: 'rgba(210,153,34,0.14)' } },
          },
          danger: {
            default: { value: { base: '#cf222e', _dark: '#f85149' } },
            subtle: { value: { base: 'rgba(207,34,46,0.10)', _dark: 'rgba(248,81,73,0.14)' } },
          },

          /**
           * The swisscode identity, from the README hero, and RESERVED FOR IT.
           *
           * The red and coral are the brand — the logo mark and the "code" half
           * of the wordmark. They are deliberately NOT the interactive accent:
           * the README borrows GitHub's palette, where red is the identity and a
           * separate blue carries interaction, and doing the same here keeps a
           * brand-red button from reading as a danger button (the dark-mode
           * danger and the coral are nearly the same hue).
           *
           * `mark` is the red HANDLE — a fill behind a white terminal prompt,
           * NOT a cross (see the note in web/src/Brand.tsx on why the Swiss
           * cross was retired). White-on-red reads on any surface, so it needs
           * no light/dark variant. `wordmark` IS text, so light mode darkens the
           * coral to clear the 3:1 large-text bar on a white panel (measured
           * 4.3:1 at #d93a2b), while dark mode keeps the bright #ff5a4d (5:1).
           */
          brand: {
            mark: { value: '#da291c' },
            wordmark: { value: { base: '#d93a2b', _dark: '#ff5a4d' } },
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

  /**
   * The page's own defaults, DERIVED rather than restated.
   *
   * These three values used to sit in `web/src/index.css` as literal CSS —
   * `font-size: 13px; line-height: 1.5; letter-spacing: -0.006em` — a
   * byte-for-byte copy of `textStyles.body` above, in the one file the type
   * checker does not police. Editing the composition would have left the page
   * default behind, which is precisely the twelve-hardcoded-font-sizes failure
   * this config exists to prevent. Naming the composition is the whole fix.
   */
  globalCss: {
    'html, body, #root': { height: '100%' },
    body: {
      margin: '0',
      bg: 'surface.canvas',
      color: 'content.primary',
      fontFamily: 'sans',
      textStyle: 'body',
      // Antialiasing matters most in dark mode, where unhinted text looks heavy.
      WebkitFontSmoothing: 'antialiased',
      MozOsxFontSmoothing: 'grayscale',
      textRendering: 'optimizeLegibility',
    },
    'input, select, button, textarea': { fontFamily: 'inherit', fontSize: 'inherit' },
  },

  outdir: 'styled-system',
})
