import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_SETTINGS, saveSettings, errorMessage, type Settings } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { startOperation } from '@/lib/operations'
import { createSettingsQueryOptions } from '@/lib/query-options'
import { setSettingsFlusher } from '@/lib/settings-flush'

interface SettingsContextValue {
  settings: Settings
  /** Merge `patch` into the settings: applied immediately, persisted async. */
  updateSettings: (patch: Partial<Settings>) => void
  /**
   * Like {@link updateSettings}, but the patch is computed from the latest
   * merged settings at apply time. Use this for read-modify-write updates
   * (e.g. list edits after an `await`): React applies functional updaters
   * sequentially, so concurrent edits compose instead of clobbering each
   * other through a stale render-time snapshot. Updaters dispatched before
   * hydration are queued and replayed over the loaded document — an edit of
   * a list the disk is about to supply must not be computed from defaults.
   */
  updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) => void
  /**
   * Resolves once the initial disk load has settled, and with which outcome.
   * After `'failed'`, changes apply session-only and nothing persists —
   * callers that pair a settings entry with state elsewhere (e.g. a keychain
   * secret) must await this before writing the other half, or a restart
   * loses the entry and strands its counterpart. A boolean can't close that
   * window: a write racing the in-flight load needs the eventual outcome.
   */
  whenSettingsLoaded: () => Promise<SettingsLoadOutcome>
}

/** How the initial settings load ended (`'failed'` ⇒ session-only mode). */
export type SettingsLoadOutcome = 'loaded' | 'failed'

type SettingsLoadState = SettingsLoadOutcome | 'pending'
type SettingsUpdater = (current: Settings) => Partial<Settings>

const SettingsContext = createContext<SettingsContextValue | null>(null)

interface LoadSettle {
  promise: Promise<SettingsLoadOutcome>
  resolve: (outcome: SettingsLoadOutcome) => void
}

function createLoadSettle(): LoadSettle {
  let resolve: (outcome: SettingsLoadOutcome) => void = () => {}
  const promise = new Promise<SettingsLoadOutcome>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

interface SettingsProviderProps {
  children: ReactNode
}

export function SettingsProvider({ children }: SettingsProviderProps): ReactElement {
  const bridgeReady = useBridgeReady()
  const queryClient = useQueryClient()
  const queryOptions = createSettingsQueryOptions()
  const settingsQuery = useQuery({
    ...queryOptions,
    enabled: bridgeReady,
  })
  const [preloadPatch, setPreloadPatch] = useState<Partial<Settings>>({})
  const preloadPatchRef = useRef<Partial<Settings>>({})
  const pendingUpdaters = useRef<SettingsUpdater[] | null>([])
  const [loadState, setLoadState] = useState<SettingsLoadState>('pending')
  const loadStateRef = useRef<SettingsLoadState>('pending')
  const [sessionSettings, setSessionSettings] = useState<Settings | null>(null)
  const diskSettings = useRef<Settings | null>(null)
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS)

  const loadSettle = useRef<LoadSettle | null>(null)
  if (loadSettle.current === null) {
    loadSettle.current = createLoadSettle()
  }
  const whenSettingsLoaded = useCallback(
    (): Promise<SettingsLoadOutcome> => loadSettle.current?.promise ?? Promise.resolve('failed'),
    [],
  )
  useEffect(() => {
    if (loadState !== 'pending') {
      loadSettle.current?.resolve(loadState)
    }
  }, [loadState])

  const persistQueue = useRef<Promise<void>>(Promise.resolve())
  const lastPersisted = useRef<Settings | null>(null)
  const persistIfChanged = useCallback((target = settingsRef.current): Promise<void> => {
    const disk = diskSettings.current
    if (disk === null) {
      return persistQueue.current
    }
    const confirmed = lastPersisted.current ?? disk
    if (target === confirmed) {
      lastPersisted.current = confirmed
      return persistQueue.current
    }
    persistQueue.current = persistQueue.current
      .then(() => saveSettings(target))
      .then(() => {
        lastPersisted.current = target
      })
      .catch((error) => {
        startOperation('Saving settings').fail(errorMessage(error))
      })
    return persistQueue.current
  }, [])

  const setLoadedSettings = useCallback(
    (updater: (current: Settings) => Settings): void => {
      const next = queryClient.setQueryData(queryOptions.queryKey, (current) =>
        current === undefined ? current : updater(current),
      )
      if (next !== undefined) {
        settingsRef.current = next
        void persistIfChanged(next)
      }
    },
    [persistIfChanged, queryClient, queryOptions.queryKey],
  )

  const updateSettings = useCallback(
    (patch: Partial<Settings>): void => {
      if (loadStateRef.current === 'pending') {
        preloadPatchRef.current = { ...preloadPatchRef.current, ...patch }
        setPreloadPatch(preloadPatchRef.current)
        return
      }
      if (loadStateRef.current === 'loaded') {
        setLoadedSettings((current) => ({ ...current, ...patch }))
        return
      }
      setSessionSettings((current) => {
        const next = { ...(current ?? DEFAULT_SETTINGS), ...patch }
        settingsRef.current = next
        return next
      })
    },
    [setLoadedSettings],
  )

  const updateSettingsWith = useCallback(
    (updater: SettingsUpdater): void => {
      if (loadStateRef.current === 'pending') {
        pendingUpdaters.current?.push(updater)
        return
      }
      if (loadStateRef.current === 'loaded') {
        setLoadedSettings((current) => ({ ...current, ...updater(current) }))
        return
      }
      setSessionSettings((current) => {
        const base = current ?? DEFAULT_SETTINGS
        const next = { ...base, ...updater(base) }
        settingsRef.current = next
        return next
      })
    },
    [setLoadedSettings],
  )

  useEffect(() => {
    if (loadStateRef.current !== 'pending') {
      return
    }

    let outcome: SettingsLoadOutcome
    let current: Settings
    if (settingsQuery.isSuccess) {
      outcome = 'loaded'
      diskSettings.current = settingsQuery.data
      current = { ...settingsQuery.data, ...preloadPatchRef.current }
    } else if (!bridgeReady || settingsQuery.isError) {
      outcome = 'failed'
      current = { ...DEFAULT_SETTINGS, ...preloadPatchRef.current }
    } else {
      return
    }

    const queued = pendingUpdaters.current ?? []
    pendingUpdaters.current = null
    for (const updater of queued) {
      current = { ...current, ...updater(current) }
    }

    if (outcome === 'loaded') {
      current = queryClient.setQueryData(queryOptions.queryKey, current) ?? current
    } else {
      setSessionSettings(current)
    }
    settingsRef.current = current
    loadStateRef.current = outcome
    setLoadState(outcome)
    preloadPatchRef.current = {}
    setPreloadPatch({})
    if (outcome === 'loaded') {
      void persistIfChanged(current)
    }
  }, [
    bridgeReady,
    persistIfChanged,
    queryClient,
    queryOptions.queryKey,
    settingsQuery.data,
    settingsQuery.isError,
    settingsQuery.isSuccess,
  ])

  const settings = useMemo<Settings>(() => {
    if (loadState === 'loaded') {
      return settingsQuery.data ?? settingsRef.current
    }
    if (loadState === 'failed') {
      return sessionSettings ?? settingsRef.current
    }
    return { ...DEFAULT_SETTINGS, ...preloadPatch }
  }, [loadState, preloadPatch, sessionSettings, settingsQuery.data])

  const loadErrorSurfaced = useRef(false)
  useEffect(() => {
    if (settingsQuery.error && !loadErrorSurfaced.current) {
      loadErrorSurfaced.current = true
      startOperation('Loading settings').fail(errorMessage(settingsQuery.error))
    }
  }, [settingsQuery.error])

  useEffect(() => {
    setSettingsFlusher(persistIfChanged)
    return () => setSettingsFlusher(null)
  }, [persistIfChanged])

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, updateSettings, updateSettingsWith, whenSettingsLoaded }),
    [settings, updateSettings, updateSettingsWith, whenSettingsLoaded],
  )

  return <SettingsContext value={value}>{children}</SettingsContext>
}

/** Access the current settings and the updater. Use within a SettingsProvider. */
export function useSettings(): SettingsContextValue {
  const context = use(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}
