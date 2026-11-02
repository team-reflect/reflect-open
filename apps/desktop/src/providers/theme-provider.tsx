import { useEffect } from 'react'
import type { ResolvedTheme as AppResolvedTheme, ThemeState } from '@reflect/app'
import { useSelector } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/** The concrete theme actually applied to the document. */
export type ResolvedTheme = AppResolvedTheme

function selectResolvedTheme(state: ThemeState): ResolvedTheme {
  return state.resolved
}

function selectSettled(state: ThemeState): boolean {
  return state.settled
}

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
  const { theme } = useAppServices()
  const resolvedTheme = useSelector(theme, selectResolvedTheme)
  const settled = useSelector(theme, selectSettled)

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
