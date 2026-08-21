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
import { useQuery } from '@tanstack/react-query'
import { isDeepEqual } from '@ocavue/utils'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  errorMessage,
  type Settings,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { startOperation } from '@/lib/operations'
import { queryKeys } from '@/lib/query-client'
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
  const { data: loaded, error: loadError } = useQuery({
    queryKey: queryKeys.settings.all,
    queryFn: loadSettings,
    enabled: bridgeReady,
  })
  const [overrides, setOverrides] = useState<Partial<Settings>>({})
  const loadedRef = useRef(loaded)
  useEffect(() => {
    loadedRef.current = loaded
  })

  // One derived load-state drives everything that waits on hydration (the
  // updater queue drain, the settle promise). With no bridge installed
  // (plain-browser dev) the query never runs, so there is nothing to wait
  // for: that settles immediately as 'failed' — i.e. session-only — instead
  // of leaving waiters hanging on a load that will never happen.
  const loadState: SettingsLoadState =
    !bridgeReady || loadError !== null ? 'failed' : loaded !== undefined ? 'loaded' : 'pending'

  // Defaults are usable before the IPC load settles — no loading gate.
  const settings = useMemo<Settings>(
    () => ({ ...DEFAULT_SETTINGS, ...loaded, ...overrides }),
    [loaded, overrides],
  )

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setOverrides((current) => ({ ...current, ...patch }))
  }, [])

  const applyUpdater = useCallback((updater: (current: Settings) => Partial<Settings>) => {
    setOverrides((current) => {
      // Rebuild the merged document from the *queued* overrides, not the
      // render-time `settings` value — React applies these updaters in
      // order, so each one sees the result of the previous edit even when
      // both were dispatched from stale closures.
      const merged: Settings = { ...DEFAULT_SETTINGS, ...loadedRef.current, ...current }
      return { ...current, ...updater(merged) }
    })
  }, [])

  // Read-modify-write trails hydration, like persistence does: an updater
  // applied over defaults would compute its patch from a list the disk
  // document is about to supply (an early "add" would then override — and on
  // the next save erase — every persisted entry). `null` marks the queue as
  // drained; from then on updaters apply directly.
  const pendingUpdaters = useRef<((current: Settings) => Partial<Settings>)[] | null>([])

  const updateSettingsWith = useCallback(
    (updater: (current: Settings) => Partial<Settings>) => {
      if (pendingUpdaters.current !== null) {
        pendingUpdaters.current.push(updater)
        return
      }
      applyUpdater(updater)
    },
    [applyUpdater],
  )

  useEffect(() => {
    // Drain once the load settles either way — after 'failed' the updaters
    // apply over defaults and changes stay session-only, matching the
    // scalar-update semantics below.
    if (loadState === 'pending' || pendingUpdaters.current === null) {
      return
    }
    const queued = pendingUpdaters.current
    pendingUpdaters.current = null
    for (const updater of queued) {
      applyUpdater(updater)
    }
  }, [loadState, applyUpdater])

  // Settling the load outcome as a promise lets callers *await* it; resolving
  // an already-resolved promise is a no-op, so the effect can stay simple.
  const loadSettle = useRef<LoadSettle | null>(null)
  if (loadSettle.current === null) {
    loadSettle.current = createLoadSettle()
  }
  useEffect(() => {
    if (loadState !== 'pending') {
      loadSettle.current?.resolve(loadState)
    }
  }, [loadState])
  const whenSettingsLoaded = useCallback(
    (): Promise<SettingsLoadOutcome> => loadSettle.current?.promise ?? Promise.resolve('failed'),
    [],
  )

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
  useEffect(() => {
    settingsRef.current = settings
  })

  const persistIfChanged = useCallback((): Promise<void> => {
    const disk = loadedRef.current
    if (disk === undefined) {
      return persistQueue.current // never write over an unread store
    }
    const target = settingsRef.current
    const confirmed = lastPersisted.current ?? disk
    // Structural, not reference: the schema transforms rebuild arrays and
    // records on every parse, so an equal-but-rebuilt value would read as a
    // change and trigger a spurious save.
    if (isDeepEqual(target, confirmed)) {
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
