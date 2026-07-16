// Match the OS theme before the design-system CSS applies, so a dark-mode
// user does not see a light-to-dark flash between the first paint and the
// ThemeProvider mounting. The ThemeProvider (`providers/theme-provider.tsx`)
// overrides this once user settings load. Kept as an external file because
// the app CSP is `script-src 'self'` — inline scripts would be blocked.
(function () {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', prefersDark)
  document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light'
})()
