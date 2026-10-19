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
  BackupState,
  GraphServices,
  GraphSessionState,
  Settings,
} from '@reflect/core'
import {
  createTestClockService,
  createTestCoreServices,
  createTestPlatformService,
  createTestBackupService,
  type TestCoreServices,
  type TestDatabaseService,
  type TestBackupService,
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
   * The open graph, reported through `app.graphSession.setGraph()`. Left out,
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
  sync?: BackupState
  /**
   * The facts of the test platform. Only without `app`; see {@link MOBILE_PLATFORM}.
   */
  platform?: TestPlatformOptions
  /**
   * Defaults to a fresh client without retries, cleared when the test ends.
   */
  queryClient?: QueryClient
  /**
   * Replaces fields of the app layer built over `app`, e.g. `{ update }` or a whole
   * `createTestAppServices(app)` a test must share with the render.
   */
  appServices?: Partial<AppServices>
  /**
   * Wraps `ui` inside every provider, for providers this helper does not mount.
   */
  wrapper?: (children: ReactNode) => ReactNode
  /**
   * Mount only `CoreServicesProvider` and the query client, for a test of a
   * provider this helper otherwise mounts, or of one that needs no graph.
   * `app` keeps its own graph session, and the settings load is not awaited.
   * Not with `graph`, `graphState`, `route` or `sync`.
   */
  servicesOnly?: boolean
}

interface InAppHandles<App extends CoreServices> {
  readonly app: App
  /**
   * The app layer built over `app`.
   */
  readonly appServices: TestAppServices
  readonly queryClient: QueryClient
  /**
   * The scripted backup when `sync` was a `BackupState`, else `null`.
   */
  readonly backup: TestBackupService | null
}

export interface InAppRenderResult<App extends CoreServices>
  extends RenderResult, InAppHandles<App> {}

export interface InAppRenderHookResult<Result, Props, App extends CoreServices>
  extends RenderHookResult<Result, Props>, InAppHandles<App> {}

type AnyOptions = RenderInAppOptions & { app?: CoreServices | undefined }

/**
 * The test core services over `database`, reporting to an app-layer operations list.
 */
function createApp(
  database: TestDatabaseService,
  backup: TestBackupService | null,
  platform: TestPlatformOptions | undefined,
): TestCoreServices {
  const clock = createTestClockService()
  return createTestCoreServices({
    database,
    clock,
    // The app layer's operations list is the port the core services report to.
    progress: createTestOperationsService(clock),
    ...(platform === undefined ? {} : { platform: createTestPlatformService(platform) }),
    ...(backup === null ? {} : { backup }),
  })
}

/**
 * Prepare `app` and the provider tree; the caller renders `wrap(ui)` and calls `dispose` after.
 */
async function prepare(options: AnyOptions | undefined): Promise<
  InAppHandles<CoreServices> & {
    wrap: (children: ReactNode) => ReactElement
    dispose: () => void
  }
> {
  const backup =
    options?.sync === undefined ? null : createTestBackupService({ state: options.sync })
  if (options?.app !== undefined && (backup !== null || options.platform !== undefined)) {
    throw new Error(
      'renderInApp: with your own `app`, give it the platform and the backup service yourself',
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
  // The database of an app this helper builds; `dispose` closes it. A caller's `app` keeps its own.
  let database: TestDatabaseService | null = null
  let app: CoreServices
  if (options?.app === undefined) {
    database = createWasmTestDatabaseService()
    app = createApp(database, backup, options?.platform)
  } else {
    app = options.app
  }

  const { graphSession, settings } = app
  if (options?.settings !== undefined) {
    if (!('seed' in settings)) {
      throw new Error('renderInApp: `settings` needs a test settings service in `app`')
    }
    ;(settings as TestCoreServices['settings']).seed(options.settings)
  }
  if (!servicesOnly) {
    if (!('setGraph' in graphSession) || !('setState' in graphSession)) {
      throw new Error('renderInApp: `app.graphSession` must be a test graph session')
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
  const appLayer = createTestAppServices(app, options?.appServices)
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
        <CoreServicesProvider services={app}>
          <AppServicesProvider services={appLayer}>
            <QueryClientProvider client={queryClient}>{wrapped}</QueryClientProvider>
          </AppServicesProvider>
        </CoreServicesProvider>
      )
    }
    return (
      <CoreServicesProvider services={app}>
        <AppServicesProvider services={appLayer}>
          <QueryClientProvider client={queryClient}>
            <GraphProvider platform={app.platform.appPlatform}>
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
    app,
    appServices: appLayer,
    queryClient,
    backup,
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
 * the graph services) and `RouterProvider`. All of them read `app`, which defaults to test doubles. Tests drive and observe
 * the app through the returned `app`: `app.graphSession.setGraph()`,
 * `app.settings.get()`, `appServices.navigation.navigations()`,
 * `app.progress.getAll()`.
 *
 * Pass your own `app` to replace or spy on a service before the first render.
 */
export async function renderInApp<App extends CoreServices = TestCoreServices>(
  ui: ReactNode,
  options?: RenderInAppOptions & { app?: App },
): Promise<InAppRenderResult<App>> {
  const { wrap, dispose, ...handles } = await prepare(options)
  try {
    const screen = await render(ui, { wrapper: ({ children }) => wrap(children) })
    onTestFinished(async () => {
      await screen.unmount()
      dispose()
    })
    return Object.assign(screen, handles as InAppHandles<App>)
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
  App extends CoreServices = TestCoreServices,
>(
  hook: (props?: Props) => Result,
  options?: RenderInAppOptions & { app?: App; initialProps?: Props },
): Promise<InAppRenderHookResult<Result, Props, App>> {
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
    return Object.assign(rendered, handles as InAppHandles<App>)
  } catch (error) {
    // A render that throws still releases the database.
    dispose()
    throw error
  }
}
