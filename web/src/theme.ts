// Light, dark, or whatever the machine says.
//
// THE RESOLVED VALUE IS THE ONLY THING THAT REACHES CSS. `data-theme` on <html>
// is always `light` or `dark`, never `system`: components then style against a
// single condition rather than each having to reason about a three-state
// preference, which is the difference between one code path and two.
//
// The preference is stored; the resolution is derived. Those are different
// values and conflating them is what produces a UI that ignores the machine
// switching to dark at sunset because the user once clicked "light".

const STORAGE_KEY = 'swisscode-theme'

/** What the user asked for. `system` is a real answer, and the default. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** What the page actually renders. Never `system`. */
export type ResolvedTheme = 'light' | 'dark'

const PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (PREFERENCES as readonly string[]).includes(value)
}

/** The stored preference, or `system` when there is none or it is unusable. */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isThemePreference(stored) ? stored : 'system'
  } catch {
    // Private browsing, a blocked origin, a disabled storage API. A theme is
    // not worth failing a page over.
    return 'system'
  }
}

export function writePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    /* the theme still applies for this page load */
  }
}

export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

/**
 * Stamp the resolved theme where CSS can see it.
 *
 * Also sets `color-scheme`, which is what makes the browser's OWN chrome match
 * — form controls, scrollbars, the flash of background before paint. Styling
 * every surface and leaving that unset is why an otherwise-dark app renders a
 * white scrollbar.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
}
