import { createContext, use, useEffect, useMemo, type ReactNode } from 'react'
import type { GraphBootService } from '@reflect/app'
import type {
  AppPlatform,
  GraphInfo,
  GraphServices,
  GraphSession,
  GraphSessionState,
  GraphStatus,
  IndexLifecycleProgress,
  RecentGraph,
} from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'
import {
  GraphServicesProvider,
  useAppServices,
  useCoreServices,
} from '@/services/services-provider.tsx'

/**
 * The graph context surface: the graph actions and the platform. All of them
 * are stable; read the session state through the slice hooks below.
 */
type GraphContextValue = Pick<
  GraphBootService,
  'pickAndOpen' | 'chooseGraph' | 'openRecent' | 'deleteGraph'
> & {
  /**
   * `GraphBootService.createGraphAt`.
   */
  createAt: GraphBootService['createGraphAt']
  /**
   * `GraphBootService.forgetRecent`.
   */
  forget: GraphBootService['forgetRecent']
  /**
   * Which UI family the shell was built for (Plan 19's root gate), fixed at
   * boot; gates platform-only surfaces like the iOS subscription paywall.
   */
  platform: AppPlatform
}

type State = GraphSessionState<GraphServices>

function selectStatus(state: State): GraphStatus {
  return state.status
}

function selectGraph(state: State): GraphInfo | null {
  return state.graph
}

function selectIndexGeneration(state: State): number | null {
  return state.indexGeneration
}

function selectReconciling(progress: IndexLifecycleProgress): boolean {
  return progress === 'reconciling'
}

function selectError(state: State): string | null {
  return state.error
}

function selectRecents(state: State): RecentGraph[] {
  return state.recents
}

/**
 * The recents of a shell that offers none: one shared array, so it never
 * changes identity.
 */
const NO_RECENTS: RecentGraph[] = []

function selectSession(state: State): GraphSession | null {
  return state.session
}

function selectServices(state: State): GraphServices | null {
  return state.services
}

const GraphContext = createContext<GraphContextValue | null>(null)

/**
 * Owns the active graph and the open/choose flow. On mount it auto-opens the
 * most-recent graph (so the app reopens where you left off) and otherwise shows
 * the chooser. All durable file access goes through `@reflect/core` commands.
 *
 * On mobile (Plans 19/21) there is no chooser and no recents-driven reopen:
 * the graph lives in one of two fixed roots — the app's iCloud Drive
 * container (the recommended default; syncs across devices) or the app
 * sandbox `Documents/` — and only the *kind* is persisted. Absolute paths are
 * **derived fresh every launch** because iOS container paths change across
 * restore/update, so a persisted recent would point at a dead path.
 * Everything downstream of the open is shared.
 */
export function GraphProvider({
  children,
  platform = 'desktop',
}: {
  children: ReactNode
  platform?: AppPlatform
}) {
  const { graphSession: session } = useCoreServices()
  const { graphBoot, mobileOnboarding } = useAppServices()
  const services = useSelector(session, selectServices)

  // Desktop main-window boot reopens the most recent graph or shows the
  // chooser; a secondary note window adopts the main window's graph. Mobile
  // opens through the onboarding service below.
  useEffect(() => graphBoot.boot(), [graphBoot])

  // The mobile bootstrap + onboarding (Plans 19/21) lives in its own
  // service; it opens and parks through the session. Inert on desktop.
  useEffect(() => mobileOnboarding.boot(), [mobileOnboarding])

  const value = useMemo<GraphContextValue>(
    () => ({
      pickAndOpen: () => graphBoot.pickAndOpen(),
      chooseGraph: () => graphBoot.chooseGraph(),
      openRecent: (root) => graphBoot.openRecent(root),
      deleteGraph: () => graphBoot.deleteGraph(),
      createAt: (root) => graphBoot.createGraphAt(root),
      forget: (root) => graphBoot.forgetRecent(root),
      platform,
    }),
    [graphBoot, platform],
  )

  return (
    <GraphContext value={value}>
      <GraphServicesProvider services={services}>{children}</GraphServicesProvider>
    </GraphContext>
  )
}

/**
 * The graph open/choose actions and the platform. Use within a GraphProvider.
 */
export function useGraphActions(): GraphContextValue {
  const context = use(GraphContext)
  if (!context) {
    throw new Error('useGraphActions must be used within a GraphProvider')
  }
  return context
}

/**
 * A slice of the core graph session's state.
 */
function useGraphSelector<T>(selector: (state: State) => T): T {
  return useSelector(useCoreServices().graphSession, selector)
}

/**
 * The lifecycle status of the active graph.
 */
export function useGraphStatus(): GraphStatus {
  return useGraphSelector(selectStatus)
}

/**
 * The open graph, or `null` while none is open.
 */
export function useGraphInfo(): GraphInfo | null {
  return useGraphSelector(selectGraph)
}

/**
 * The open index session generation (`GraphSessionState.indexGeneration`).
 */
export function useIndexGeneration(): number | null {
  return useGraphSelector(selectIndexGeneration)
}

/**
 * True while the background index reconcile is running.
 */
export function useGraphIndexing(): boolean {
  return useSelector(useCoreServices().indexLifecycle.progress, selectReconciling)
}

/**
 * The last error of the graph flows, or `null`.
 */
export function useGraphError(): string | null {
  return useGraphSelector(selectError)
}

/**
 * The recently opened graphs.
 */
export function useGraphRecents(): RecentGraph[] {
  const { platform } = useCoreServices()
  const recents = useGraphSelector(selectRecents)
  // The shell still records every open, but a mobile recent is a dead path
  // after a restore or update; the iPad's desktop footer and ⌘1–9 must not
  // offer them (graphs switch through the mobile graph list).
  return platform.appPlatform === 'desktop' ? recents : NO_RECENTS
}

/**
 * The open graph as one object, or `null` while none is open.
 */
export function useGraphSession(): GraphSession | null {
  return useGraphSelector(selectSession)
}
