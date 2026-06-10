import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DEFAULT_SETTINGS,
  hasBridge,
  loadSettings,
  saveSettings,
  errorMessage,
  type Settings,
} from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { setSettingsFlusher } from '@/lib/settings-flush'

/**
 * App-wide user settings (config-dir JSON, not graph state), applied instantly.
 *
 * The design is hydration + overrides: the query reads the disk document once
 * and is never written afterwards; session updates accumulate in local state
 * and win over whatever the load returns **by construction**. There is no
 * optimistic cache write to defend, so an update racing the initial load needs
 * no cancellation or re-apply — the merge order is the whole story.
 */

export const SETTINGS_QUERY_KEY = ['settings'] as const

interface SettingsContextValue {
  settings: Settings
  /** Merge `patch` into the settings: applied immediately, persisted async. */
  updateSettings: (patch: Partial<Settings>) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

/** Shallow own-key equality — settings documents are flat JSON objects. */
function sameDocument(a: Settings, b: Settings): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every((key) => Object.is(a[key], b[key]))
}

interface SettingsProviderProps {
  children: ReactNode
}

export function SettingsProvider({ children }: SettingsProviderProps): ReactElement {
  const { data: loaded, error: loadError } = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: loadSettings,
    enabled: hasBridge(),
    staleTime: Infinity,
  })
  const [overrides, setOverrides] = useState<Partial<Settings>>({})

  // Defaults are usable before the IPC load settles — no loading gate.
  const settings = useMemo<Settings>(
    () => ({ ...DEFAULT_SETTINGS, ...loaded, ...overrides }),
    [loaded, overrides],
  )

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setOverrides((current) => ({ ...current, ...patch }))
  }, [])

  // A corrupt store fails the load *by design* (Rust errors rather than
  // reading empty, so a later save can't wipe the real document). Changes
  // then apply for the session only — surface that state, don't hide it.
  const loadErrorSurfaced = useRef(false)
  useEffect(() => {
    if (loadError && !loadErrorSurfaced.current) {
      loadErrorSurfaced.current = true
      startOperation('Loading settings').fail(errorMessage(loadError))
    }
  }, [loadError])

  // Persistence trails hydration. Nothing is written before the disk document
  // has been read — a save built from defaults would drop passthrough keys a
  // newer app version wrote — and the full merged document is saved so those
  // keys survive. `lastPersisted` is the last document *confirmed* on disk
  // (hydration, or a successful save): a failed write leaves it untouched, so
  // the next change or the quit flush retries the difference. Writes are
  // chained so they reach disk in apply order.
  const persistQueue = useRef<Promise<void>>(Promise.resolve())
  const lastPersisted = useRef<Settings | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded

  const persistIfChanged = useCallback((): Promise<void> => {
    const disk = loadedRef.current
    if (disk === undefined) {
      return persistQueue.current // never write over an unread store
    }
    const target = settingsRef.current
    const confirmed = lastPersisted.current ?? disk
    if (sameDocument(target, confirmed)) {
      lastPersisted.current = confirmed
      return persistQueue.current
    }
    persistQueue.current = persistQueue.current
      .then(() => saveSettings(target))
      .then(() => {
        lastPersisted.current = target
      })
      .catch((error: unknown) => {
        // The in-memory value stays applied and `lastPersisted` still points
        // at the confirmed disk document, so the difference is retried later.
        // The failure is product status, not console noise.
        startOperation('Saving settings').fail(errorMessage(error))
      })
    return persistQueue.current
  }, [])

  useEffect(() => {
    void persistIfChanged()
  }, [loaded, settings, persistIfChanged])

  // Quit-time persistence (window close, ⌘Q, reload): installQuitFlush drains
  // this provider's queue — and retries anything unconfirmed — before exit.
  useEffect(() => {
    setSettingsFlusher(persistIfChanged)
    return () => setSettingsFlusher(null)
  }, [persistIfChanged])

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
