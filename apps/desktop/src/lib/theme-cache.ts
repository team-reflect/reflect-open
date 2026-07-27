import type { ThemePreference } from '@reflect/core'

/**
 * Where the theme preference is mirrored for the *next* launch.
 *
 * The settings document is the source of truth, but it loads over IPC — too
 * late for the first paint. `public/theme-init.js` reads this key before the
 * design-system CSS is evaluated so a user who pinned `light` or `dark` never
 * sees the OS theme painted first. That script is served raw (no bundling, so
 * no imports), which is why the key literal is repeated there;
 * `theme-cache.test.ts` guards against the two drifting apart.
 */
export const THEME_PREFERENCE_CACHE_KEY = 'reflect.theme.preference'

/**
 * Mirror the persisted theme preference so the next launch can apply it before
 * the frontend boots.
 *
 * The *preference* is cached rather than the resolved `light`/`dark`: a user on
 * `system` whose OS theme changed while the app was closed must re-resolve from
 * `prefers-color-scheme`, not replay a stale answer. Best-effort — a webview
 * with storage unavailable just falls back to the OS preference.
 */
export function writeCachedThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_PREFERENCE_CACHE_KEY, preference)
  } catch {
    // Storage is unavailable; theme-init.js falls back to `prefers-color-scheme`.
  }
}
