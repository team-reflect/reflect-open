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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_SETTINGS, errorMessage, type Settings } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { startOperation } from '@/lib/operations'
import {
  createSettingsQueryOptions,
  createSettingsSaveMutationOptions,
} from '@/lib/query-options'
import { setSettingsFlusher } from '@/lib/settings-flush'

interface SettingsContextValue {
  settings: Settings
  /** Merge `patch` into the settings: applied immediately, persisted async. */
  updateSettings: (patch: Partial<Settings>) => void
  /** Compute a patch from the latest settings; pre-load calls replay after hydration. */
  updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) => void
  /** Resolve after the initial disk load; `'failed'` means session-only updates. */
  whenSettingsLoaded: () => Promise<SettingsLoadOutcome>
}

/** How the initial settings load ended (`'failed'` ⇒ session-only mode). */
export type SettingsLoadOutcome = 'loaded' | 'failed'

type SettingsUpdater = (current: Settings) => Partial<Settings>

const SettingsContext = createContext<SettingsContextValue | null>(null)

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
  const [sessionSettings, setSessionSettings] = useState<Settings | null>(null)

  const resolveLoad = useRef<(outcome: SettingsLoadOutcome) => void>(() => {})
  const [loadPromise] = useState(
    () =>
      new Promise<SettingsLoadOutcome>((resolve) => {
        resolveLoad.current = resolve
      }),
  )
  const whenSettingsLoaded = useCallback(() => loadPromise, [loadPromise])
  const loadState =
    pendingUpdaters.current === null
      ? settingsQuery.isSuccess
        ? 'loaded'
        : 'failed'
      : 'pending'
  useEffect(() => {
    if (loadState !== 'pending') {
      resolveLoad.current(loadState)
    }
  }, [loadState])

  const dirty = useRef(false)
  const lastSubmission = useRef<Promise<void>>(Promise.resolve())
  const { mutateAsync: save } = useMutation({
    ...createSettingsSaveMutationOptions(),
    onSuccess: (_data, target) => {
      if (queryClient.getQueryData(queryOptions.queryKey) === target) {
        dirty.current = false
      }
    },
    onError: (error) => startOperation('Saving settings').fail(errorMessage(error)),
  })

  const submitSettings = useCallback(
    (target: Settings): void => {
      dirty.current = true
      lastSubmission.current = save(target).catch(() => {})
    },
    [save],
  )

  const applySettingsUpdate = useCallback(
    (updater: SettingsUpdater): void => {
      if (settingsQuery.isSuccess) {
        const previous = queryClient.getQueryData(queryOptions.queryKey)
        const next = queryClient.setQueryData(queryOptions.queryKey, (current) =>
          current === undefined ? current : { ...current, ...updater(current) },
        )
        if (next !== undefined && (dirty.current || next !== previous)) {
          submitSettings(next)
        }
        return
      }
      setSessionSettings((current) => {
        const base = current ?? DEFAULT_SETTINGS
        return { ...base, ...updater(base) }
      })
    },
    [queryClient, queryOptions.queryKey, settingsQuery.isSuccess, submitSettings],
  )

  const updateSettings = useCallback(
    (patch: Partial<Settings>): void => {
      if (pendingUpdaters.current !== null) {
        preloadPatchRef.current = { ...preloadPatchRef.current, ...patch }
        setPreloadPatch(preloadPatchRef.current)
        return
      }
      applySettingsUpdate(() => patch)
    },
    [applySettingsUpdate],
  )

  const updateSettingsWith = useCallback(
    (updater: SettingsUpdater): void => {
      if (pendingUpdaters.current !== null) {
        pendingUpdaters.current?.push(updater)
        return
      }
      applySettingsUpdate(updater)
    },
    [applySettingsUpdate],
  )

  useEffect(() => {
    if (pendingUpdaters.current === null) {
      return
    }

    const loaded = settingsQuery.isSuccess
    let current: Settings
    if (loaded) {
      current = { ...settingsQuery.data, ...preloadPatchRef.current }
    } else if (!bridgeReady || settingsQuery.isError) {
      current = { ...DEFAULT_SETTINGS, ...preloadPatchRef.current }
      if (settingsQuery.error) {
        startOperation('Loading settings').fail(errorMessage(settingsQuery.error))
      }
    } else {
      return
    }

    const queued = pendingUpdaters.current ?? []
    pendingUpdaters.current = null
    for (const updater of queued) {
      current = { ...current, ...updater(current) }
    }

    if (loaded) {
      current = queryClient.setQueryData(queryOptions.queryKey, current) ?? current
    } else {
      setSessionSettings(current)
    }
    preloadPatchRef.current = {}
    setPreloadPatch({})
    if (loaded && current !== settingsQuery.data) {
      submitSettings(current)
    }
  }, [
    bridgeReady,
    queryClient,
    queryOptions.queryKey,
    settingsQuery.data,
    settingsQuery.isError,
    settingsQuery.isSuccess,
    submitSettings,
  ])

  const settings = useMemo<Settings>(() => {
    if (loadState === 'loaded') {
      return settingsQuery.data ?? DEFAULT_SETTINGS
    }
    if (loadState === 'failed') {
      return sessionSettings ?? DEFAULT_SETTINGS
    }
    return { ...DEFAULT_SETTINGS, ...preloadPatch }
  }, [loadState, preloadPatch, sessionSettings, settingsQuery.data])

  const drainSubmissions = useCallback(async (): Promise<void> => {
    let submission = lastSubmission.current
    await submission
    while (submission !== lastSubmission.current) {
      submission = lastSubmission.current
      await submission
    }
  }, [])
  const flush = useCallback(async (): Promise<void> => {
    await drainSubmissions()
    const current = queryClient.getQueryData(queryOptions.queryKey)
    if (dirty.current && current !== undefined) {
      submitSettings(current)
      await drainSubmissions()
    }
  }, [drainSubmissions, queryClient, queryOptions.queryKey, submitSettings])

  useEffect(() => {
    setSettingsFlusher(flush)
    return () => setSettingsFlusher(null)
  }, [flush])

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
