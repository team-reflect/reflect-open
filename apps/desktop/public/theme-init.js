// Apply the theme before the design-system CSS does, so the first painted
// frame is already the theme the user will end up on — otherwise a dark-mode
// user sees a light-to-dark flash between that paint and the ThemeProvider
// mounting. Kept as an external file because the app CSP is
// `script-src 'self'`: inline scripts would be blocked.
//
// The persisted preference lives in the settings document, which only arrives
// over IPC after the first paint, so `ThemeProvider`
// (`src/providers/theme-provider.tsx`) mirrors it into localStorage for the
// next launch. A pinned `light`/`dark` wins here; `system`, a first launch, and
// an unreadable cache all fall back to the OS preference. ThemeProvider
// re-applies the real value once settings load.
{
  // Keep in sync with THEME_PREFERENCE_CACHE_KEY in src/lib/theme-cache.ts.
  const PREFERENCE_KEY = 'reflect.theme.preference'

  function pinnedTheme() {
    try {
      const preference = localStorage.getItem(PREFERENCE_KEY)
      return preference === 'light' || preference === 'dark' ? preference : null
    } catch {
      return null
    }
  }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = pinnedTheme() ?? (prefersDark ? 'dark' : 'light')
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}
