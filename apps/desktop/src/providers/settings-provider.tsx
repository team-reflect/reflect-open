import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DEFAULT_SETTINGS, errorMessage, type Settings } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { startOperation } from '@/lib/operations'
import { createSettingsQueryOptions, createSettingsSaveMutationOptions } from '@/lib/query-options'
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

interface SettingsLoad {
  readonly promise: Promise<SettingsLoadOutcome>
  readonly resolve: (outcome: SettingsLoadOutcome) => void
}

function createSettingsLoad(): SettingsLoad {
  let resolveLoad: (outcome: SettingsLoadOutcome) => void = () => {}
  const promise = new Promise<SettingsLoadOutcome>((resolve) => {
    resolveLoad = resolve
  })
  return { promise, resolve: resolveLoad }
}

export function SettingsProvider({ children }: { children: ReactNode }): ReactElement {
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

  const [settingsLoad] = useState(createSettingsLoad)
  const whenSettingsLoaded = (): Promise<SettingsLoadOutcome> => settingsLoad.promise
  const loadState =
    pendingUpdaters.current !== null ? 'pending' : settingsQuery.isSuccess ? 'loaded' : 'failed'
  useEffect(() => {
    if (loadState !== 'pending') {
      settingsLoad.resolve(loadState)
    }
  }, [loadState, settingsLoad])

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

  const submitSettings = (target: Settings): void => {
    dirty.current = true
    lastSubmission.current = save(target).catch(() => {})
  }

  const applySettingsUpdate = (updater: SettingsUpdater): void => {
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
  }

  const updateSettings = (patch: Partial<Settings>): void => {
    if (pendingUpdaters.current !== null) {
      preloadPatchRef.current = { ...preloadPatchRef.current, ...patch }
      setPreloadPatch(preloadPatchRef.current)
      return
    }
    applySettingsUpdate(() => patch)
  }

  const updateSettingsWith = (updater: SettingsUpdater): void => {
    if (pendingUpdaters.current !== null) {
      pendingUpdaters.current.push(updater)
      return
    }
    applySettingsUpdate(updater)
  }

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

  const settings: Settings =
    loadState === 'loaded'
      ? (settingsQuery.data ?? DEFAULT_SETTINGS)
      : loadState === 'failed'
        ? (sessionSettings ?? DEFAULT_SETTINGS)
        : { ...DEFAULT_SETTINGS, ...preloadPatch }

  const drainSubmissions = async (): Promise<void> => {
    let submission = lastSubmission.current
    await submission
    while (submission !== lastSubmission.current) {
      submission = lastSubmission.current
      await submission
    }
  }
  const flush = async (): Promise<void> => {
    await drainSubmissions()
    const current = queryClient.getQueryData(queryOptions.queryKey)
    if (dirty.current && current !== undefined) {
      submitSettings(current)
      await drainSubmissions()
    }
  }

  useEffect(() => {
    setSettingsFlusher(flush)
    return () => setSettingsFlusher(null)
  }, [flush])

  const value: SettingsContextValue = {
    settings,
    updateSettings,
    updateSettingsWith,
    whenSettingsLoaded,
  }

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
