import { useEffect } from 'react'
import type { ResolvedTheme as AppResolvedTheme } from '@reflect/app'
import type { ThemePreference } from '@reflect/core'
import { useAppServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/** User-selectable theme; `system` follows the OS preference. */
export type Theme = ThemePreference

/** The concrete theme actually applied to the document. */
export type ResolvedTheme = AppResolvedTheme

/**
 * Applies the app theme by toggling the design-system `.dark` scope on the
 * document root.
 *
 * Applying the theme waits for the settings load to settle. Until then the
 * preference is the `system` default rather than the user's choice, and
 * `public/theme-init.js` has already painted the cached preference. Writing the
 * default over it would flash a pinned-light user on a dark OS to dark and
 * straight back.
 */
export function ThemeEffect(): null {
  const { theme: service } = useAppServices()
  const resolvedTheme = useServiceState(service, service.resolved)
  const settled = useServiceState(service, service.settled)

  useEffect(() => {
    if (!settled) {
      return
    }
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
  }, [settled, resolvedTheme])

  return null
}

/**
 * The current theme and a setter.
 */
export function useTheme(): {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
} {
  const { theme: service } = useAppServices()
  const theme = useServiceState(service, service.preference)
  const resolvedTheme = useServiceState(service, service.resolved)
  return { theme, resolvedTheme, setTheme: service.setPreference }
}
