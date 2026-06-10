import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_SETTINGS,
  hasBridge,
  loadSettings,
  saveSettings,
  type Settings,
} from '@reflect/core'

/**
 * App-wide user settings (config-dir JSON, not graph state): loaded once
 * through TanStack Query and updated with **instant apply** — `updateSettings`
 * writes the cache synchronously (every consumer re-renders immediately) and
 * persists in the background. Defaults are served while the load is in flight
 * so consumers never wait on disk.
 */

export const SETTINGS_QUERY_KEY = ['settings'] as const

interface SettingsContextValue {
  settings: Settings
  /** Merge `patch` into the settings: applied immediately, persisted async. */
  updateSettings: (patch: Partial<Settings>) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

interface SettingsProviderProps {
  children: ReactNode
}

export function SettingsProvider({ children }: SettingsProviderProps): ReactElement {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: loadSettings,
    enabled: hasBridge(),
    staleTime: Infinity,
  })
  const settings = data ?? DEFAULT_SETTINGS

  // Persists are chained so rapid toggles can't interleave writes out of
  // order — the last applied patch is always the last document on disk.
  const persistQueue = useRef<Promise<void>>(Promise.resolve())
  // Tracks the latest applied document. Written synchronously on update (two
  // updates in one tick must compound, not overwrite) and re-synced on render.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Monotonic update counter, so a stale re-apply (below) can recognize itself.
  const updateSeq = useRef(0)

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      const seq = ++updateSeq.current
      const next: Settings = { ...settingsRef.current, ...patch }
      settingsRef.current = next
      queryClient.setQueryData(SETTINGS_QUERY_KEY, next)
      // An update racing the initial load must win. Cancelling reverts the
      // in-flight fetch *asynchronously* — which would clobber the value just
      // applied — so it is re-applied once the cancellation has settled. Only
      // the latest update may re-apply: cancellation promises aren't
      // guaranteed to settle in call order (a later cancel can find nothing
      // in flight and resolve sooner), so an unguarded older callback could
      // overwrite a newer value.
      void queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY }).then(() => {
        if (updateSeq.current === seq) {
          queryClient.setQueryData(SETTINGS_QUERY_KEY, next)
        }
      })
      persistQueue.current = persistQueue.current
        .then(() => saveSettings(next))
        .catch((error: unknown) => {
          // The in-memory value stays applied; the next successful save (or
          // relaunch) reconciles. Settings are low-stakes enough not to block.
          console.error('saving settings failed:', error)
        })
    },
    [queryClient],
  )

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, updateSettings }),
    [settings, updateSettings],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

/** Access the current settings and the updater. Use within a SettingsProvider. */
export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}
