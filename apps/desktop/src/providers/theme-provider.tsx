import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { ThemePreference } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

/** User-selectable theme; `system` follows the OS preference. */
export type Theme = ThemePreference

/** The concrete theme actually applied to the document. */
export type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? 'dark' : 'light'
}

interface ThemeProviderProps {
  children: ReactNode
}

/**
 * Provides the app theme and applies it by toggling the design-system `.dark`
 * scope on the document root. The preference lives in the settings document
 * (the `theme` key), so a choice made anywhere — settings screen, palette
 * command — persists across launches; `system` reacts to live OS changes.
 */
export function ThemeProvider({ children }: ThemeProviderProps): ReactElement {
  const { settings, updateSettings } = useSettings()
  const theme = settings.theme
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  useEffect(() => {
    const media = window.matchMedia(DARK_MEDIA_QUERY)
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  const setTheme = useCallback(
    (next: Theme) => updateSettings({ theme: next }),
    [updateSettings],
  )

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Access the current theme and a setter. Must be used within a ThemeProvider. */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
