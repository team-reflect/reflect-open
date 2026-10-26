import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { onTestFinished } from 'vitest'
import { render, renderHook, type RenderHookResult, type RenderResult } from 'vitest-browser-react'
import type { AppServices, MobileOnboardingState } from '@reflect/app'
import {
  createTestAppServices,
  createTestOperationsService,
  type TestAppServices,
} from '@reflect/app/testing'
import type {
  CoreServices,
  GitSyncState,
  GraphServices,
  GraphSessionState,
  Settings,
} from '@reflect/core'
import {
  createTestClockService,
  createTestCoreServices,
  createTestPlatformService,
  createTestGitSyncService,
  createTestGithubConnector,
  createTestGitHostConnector,
  type TestCoreServices,
  type TestDatabaseService,
  type TestGitSyncService,
  type TestGithubConnector,
  type TestGitHostConnector,
  type TestOpenGraph,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { registerAppCommands } from '@/lib/commands/app-commands.ts'
import { GraphProvider } from '@/providers/graph-provider.tsx'
import type { Route } from '@/routing/route.ts'
import { RouterProvider } from '@/routing/router.tsx'
import { AppServicesProvider, CoreServicesProvider } from '@/services/services-provider.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'

/**
 * The platform facts of the mobile app: pass as `platform` to render a mobile surface.
 */
export const MOBILE_PLATFORM: TestPlatformOptions = {
  appPlatform: 'ios',
  isMacosDesktop: false,
  hasMacosTitleBarOverlay: false,
  surface: { mobileApp: true, touchEditor: true },
}

export interface RenderInAppOptions {
  /**
   * The open graph, reported through `core.graphSession.setGraph()`. Left out,
   * the graph `test` at `/graphs/test` is open with both generations 1. `null`
   * is the graph chooser: no graph, and no graph services.
   */
  graph?: TestOpenGraph | null | undefined
  /**
   * Reported over the graph state, e.g. `{ indexing: true }`, `{ error }`, `{ recents }`.
   */
  graphState?: Partial<GraphSessionState<GraphServices>>
  /**
   * The stored settings document, loaded before the first render.
   */
  settings?: Partial<Settings>
  /**
   * Reported over the mobile onboarding state, e.g. `{ kind: 'icloud' }`.
   */
  mobile?: Partial<MobileOnboardingState>
  /**
   * The route the router starts on; defaults to today. `null` mounts no router.
   */
  route?: Route | null
  /**
   * Swap the backup service for a scripted one that starts in this state; the
   * result's `backup` drives it. Needs an open graph.
   */
  sync?: GitSyncState
  /**
   * The facts of the test platform. Only without `core`; see {@link MOBILE_PLATFORM}.
   */
  platform?: TestPlatformOptions
  /**
   * Defaults to a fresh client without retries, cleared when the test ends.
   */
  queryClient?: QueryClient
  /**
   * Replaces fields of the app layer built over `core`, e.g. `{ update }` or a whole
   * `createTestAppServices(core)` a test must share with the render.
   */
  appServices?: Partial<AppServices>
  /**
   * Wraps `ui` inside every provider, for providers this helper does not mount.
   */
  wrapper?: (children: ReactNode) => ReactNode
  /**
   * Mount only `CoreServicesProvider` and the query client, for a test of a
   * provider this helper otherwise mounts, or of one that needs no graph.
   * `core` keeps its own graph session, and the settings load is not awaited.
   * Not with `graph`, `graphState`, `route` or `sync`.
   */
  servicesOnly?: boolean
}

interface InAppHandles<Core extends CoreServices> {
  readonly core: Core
  /**
   * The app layer built over `core`.
   */
  readonly appServices: TestAppServices
  readonly queryClient: QueryClient
  /**
   * The scripted git sync service when `sync` was a `GitSyncState`, else `null`.
   */
  readonly gitSync: TestGitSyncService | null
  /**
   * The scripted connectors beside `gitSync`, else `null`.
   */
  readonly githubConnector: TestGithubConnector | null
  readonly gitHostConnector: TestGitHostConnector | null
}

export interface InAppRenderResult<Core extends CoreServices>
  extends RenderResult, InAppHandles<Core> {}

export interface InAppRenderHookResult<Result, Props, Core extends CoreServices>
  extends RenderHookResult<Result, Props>, InAppHandles<Core> {}

type AnyOptions = RenderInAppOptions & { core?: CoreServices | undefined }

/**
 * The test core services over `database`, reporting to an app-layer operations list.
 */
function createCore(
  database: TestDatabaseService,
  sync: SyncFakes | null,
  platform: TestPlatformOptions | undefined,
): TestCoreServices {
  const clock = createTestClockService()
  return createTestCoreServices({
    database,
    clock,
    // The app layer's operations list is the port the core services report to.
    progress: createTestOperationsService(clock),
    ...(platform === undefined ? {} : { platform: createTestPlatformService(platform) }),
    ...(sync ?? {}),
  })
}

interface SyncFakes {
  readonly gitSync: TestGitSyncService
  readonly githubConnector: TestGithubConnector
  readonly gitHostConnector: TestGitHostConnector
}

/**
 * Prepare `core` and the provider tree; the caller renders `wrap(ui)` and calls `dispose` after.
 */
async function prepare(options: AnyOptions | undefined): Promise<
  InAppHandles<CoreServices> & {
    wrap: (children: ReactNode) => ReactElement
    dispose: () => void
  }
> {
  const sync: SyncFakes | null =
    options?.sync === undefined
      ? null
      : {
          gitSync: createTestGitSyncService({ state: options.sync }),
          githubConnector: createTestGithubConnector(),
          gitHostConnector: createTestGitHostConnector(),
        }
  const gitSync = sync?.gitSync ?? null
  if (options?.core !== undefined && (sync !== null || options.platform !== undefined)) {
    throw new Error(
      'renderInApp: with your own `core`, give it the platform, the git sync service, and the connectors yourself',
    )
  }
  const servicesOnly = options?.servicesOnly ?? false
  if (
    servicesOnly &&
    (options?.graph !== undefined ||
      options?.graphState !== undefined ||
      options?.route !== undefined ||
      options?.sync !== undefined)
  ) {
    throw new Error('renderInApp: `servicesOnly` mounts no graph, router or sync')
  }
  // The database of an app this helper builds; `dispose` closes it. A caller's `core` keeps its own.
  let database: TestDatabaseService | null = null
  let core: CoreServices
  if (options?.core === undefined) {
    database = createWasmTestDatabaseService()
    core = createCore(database, sync, options?.platform)
  } else {
    core = options.core
  }

  const { graphSession, settings } = core
  if (options?.settings !== undefined) {
    if (!('seed' in settings)) {
      throw new Error('renderInApp: `settings` needs a test settings service in `core`')
    }
    ;(settings as TestCoreServices['settings']).seed(options.settings)
  }
  if (!servicesOnly) {
    if (!('setGraph' in graphSession) || !('setState' in graphSession)) {
      throw new Error('renderInApp: `core.graphSession` must be a test graph session')
    }
    // The first render already shows the stored settings, not the defaults,
    // and the graph services start over them.
    await settings.whenLoaded()
    const session = graphSession as TestCoreServices['graphSession']
    session.setGraph(options?.graph === undefined ? {} : options.graph)
    if (options?.graphState !== undefined) {
      session.setState(options.graphState)
    }
  }

  const queryClient =
    options?.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const appLayer = createTestAppServices(core, options?.appServices)
  if (options?.mobile !== undefined) {
    if (!('setState' in appLayer.mobileOnboarding)) {
      throw new Error('renderInApp: `mobile` needs a test mobile onboarding service')
    }
    appLayer.mobileOnboarding.setState(options.mobile)
  }
  registerAppCommands(appLayer.commands)

  const route = options?.route
  const wrap = (children: ReactNode): ReactElement => {
    const wrapped = options?.wrapper === undefined ? children : options.wrapper(children)
    if (servicesOnly) {
      return (
        <CoreServicesProvider services={core}>
          <AppServicesProvider services={appLayer}>
            <QueryClientProvider client={queryClient}>{wrapped}</QueryClientProvider>
          </AppServicesProvider>
        </CoreServicesProvider>
      )
    }
    return (
      <CoreServicesProvider services={core}>
        <AppServicesProvider services={appLayer}>
          <QueryClientProvider client={queryClient}>
            <GraphProvider platform={core.platform.appPlatform}>
              <TooltipProvider>
                {route === null ? (
                  wrapped
                ) : (
                  <RouterProvider initialRoute={route}>{wrapped}</RouterProvider>
                )}
              </TooltipProvider>
            </GraphProvider>
          </QueryClientProvider>
        </AppServicesProvider>
      </CoreServicesProvider>
    )
  }
  return {
    core,
    appServices: appLayer,
    queryClient,
    gitSync,
    githubConnector: sync?.githubConnector ?? null,
    gitHostConnector: sync?.gitHostConnector ?? null,
    wrap,
    dispose: () => {
      queryClient.clear()
      database?.close()
    },
  }
}

/**
 * Render `ui` the way the app does: inside `CoreServicesProvider`, a query
 * client, and the real `GraphProvider` (which provides
 * the graph services) and `RouterProvider`. All of them read `core`, which defaults to test doubles. Tests drive and observe
 * the app through the returned `core`: `core.graphSession.setGraph()`,
 * `core.settings.get()`, `appServices.navigation.navigations()`,
 * `core.progress.getAll()`.
 *
 * Pass your own `core` to replace or spy on a service before the first render.
 */
export async function renderInApp<Core extends CoreServices = TestCoreServices>(
  ui: ReactNode,
  options?: RenderInAppOptions & { core?: Core },
): Promise<InAppRenderResult<Core>> {
  const { wrap, dispose, ...handles } = await prepare(options)
  try {
    const screen = await render(ui, { wrapper: ({ children }) => wrap(children) })
    onTestFinished(async () => {
      await screen.unmount()
      dispose()
    })
    return Object.assign(screen, handles as InAppHandles<Core>)
  } catch (error) {
    // A render that throws still releases the database.
    dispose()
    throw error
  }
}

/**
 * {@link renderInApp} for a hook: `hook` runs inside the same providers.
 */
export async function renderHookInApp<
  Result,
  Props = undefined,
  Core extends CoreServices = TestCoreServices,
>(
  hook: (props?: Props) => Result,
  options?: RenderInAppOptions & { core?: Core; initialProps?: Props },
): Promise<InAppRenderHookResult<Result, Props, Core>> {
  const { wrap, dispose, ...handles } = await prepare(options)
  try {
    const rendered = await renderHook<Props, Result>(hook, {
      wrapper: ({ children }) => wrap(children),
      initialProps: options?.initialProps,
    })
    onTestFinished(async () => {
      await rendered.unmount()
      dispose()
    })
    return Object.assign(rendered, handles as InAppHandles<Core>)
  } catch (error) {
    // A render that throws still releases the database.
    dispose()
    throw error
  }
}
