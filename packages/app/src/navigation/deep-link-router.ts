import {
  parseDeepLink,
  type DeepLinkIntakeService,
  type DeepLinkResolveOptions,
  type GraphSession,
  type GraphSessionService,
  type LoggerService,
  type Unlisten,
} from '@reflect/core'
import { routeForDeepLinkTarget } from './deep-link-route.ts'
import type { Route } from './route.ts'

/**

 * What acting on a deep link needs from the open graph session.

 */
export interface DeepLinkIo {
  navigate: (route: Route) => void
  /**
   * Whether the graph session or navigation intent changed while the handler
   * awaited; a stale note resolution is dropped, never navigated.
   */
  isStale?: () => boolean
}

/**

 * The open graph session that acts on incoming deep links.

 */
export interface DeepLinkSession {
  navigate: (route: Route) => void
  /**
   * Start one navigation intent for a link that addresses a place. The
   * returned probe answers whether the intent went stale since.
   */
  beginNavigationIntent: () => () => boolean
}

/**
 * Turns the URLs of the deep-link intake into navigations of the open graph
 * session, and holds a note window's first route.
 */
export interface DeepLinkRouter {
  /**
   * Feed one `reflect://` URL into the intake, as a link clicked inside the app does.
   */
  dispatch(url: string): void
  /**
   * Act on one incoming `reflect://` URL: resolve it through the intake, then
   * navigate to the route of the place or note it names. A place link
   * navigates before the call returns. A capture spools into the graph open
   * when the call starts.
   */
  handle(url: string, io: DeepLinkIo): Promise<void>
  /**
   * Route incoming URLs into `session` until the returned function is called:
   * subscribes a listener that runs {@link DeepLinkRouter.handle} for each URL
   * and logs a rejection. Only a link that addresses a place begins a
   * navigation intent. The graph open when `serve` is called is the one every
   * URL acts on; a note resolution that outlives it is dropped.
   */
  serve(session: DeepLinkSession): Unlisten
  /**
   * Record a note window's first route, derived from its initial deep link
   * BEFORE the router mounts — so the window's first workspace render is
   * already the ⌘-clicked note instead of flashing today's daily note while
   * the link rides the async intake.
   */
  setInitialWindowRoute(route: Route): void
  /**
   * The derived first route, or null (main window, reload, unresolvable
   * link). Plain slot, not consume-once: a webview boots once, and idempotent
   * reads survive StrictMode's double-invoked initializers.
   */
  getInitialWindowRoute(): Route | null
}

export interface DeepLinkRouterDeps {
  readonly intake: DeepLinkIntakeService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionService
}

class DeepLinkRouterImpl implements DeepLinkRouter {
  readonly #deps: DeepLinkRouterDeps
  #initialRoute: Route | null = null

  constructor(deps: DeepLinkRouterDeps) {
    this.#deps = deps
  }

  dispatch(url: string): void {
    this.#deps.intake.dispatch(url)
  }

  handle(url: string, io: DeepLinkIo): Promise<void> {
    return this.#handleIn(url, io, this.#deps.graphSession.getState().session)
  }

  serve(session: DeepLinkSession): Unlisten {
    const { intake, logger, graphSession } = this.#deps
    const { navigate } = session
    const graph = graphSession.getState().session
    return intake.onUrl((url) => {
      const link = parseDeepLink(url)
      // Capture and rejected URLs do not express a navigation intent, so they
      // must not supersede a note target that is still resolving.
      let io: DeepLinkIo = { navigate }
      if (link !== null && link.kind !== 'capture') {
        const intentStale = session.beginNavigationIntent()
        io = { navigate, isStale: () => graph?.signal.aborted === true || intentStale() }
      }
      this.#handleIn(url, io, graph).catch((cause: unknown) => {
        logger.error(`deep link failed: ${url}`, cause)
      })
    })
  }

  setInitialWindowRoute(route: Route): void {
    this.#initialRoute = route
  }

  getInitialWindowRoute(): Route | null {
    return this.#initialRoute
  }

  async #handleIn(url: string, io: DeepLinkIo, session: GraphSession | null): Promise<void> {
    // A place link navigates synchronously, with no round-trip through the intake.
    const link = parseDeepLink(url)
    if (link?.kind === 'navigate') {
      io.navigate(link.place)
      return
    }
    const options: DeepLinkResolveOptions =
      io.isStale === undefined ? { session } : { session, isStale: io.isStale }
    const target = await this.#deps.intake.resolve(url, options)
    const route = routeForDeepLinkTarget(target)
    if (route === null || io.isStale?.() === true) {
      return
    }
    io.navigate(route)
  }
}

export function createDeepLinkRouter(deps: DeepLinkRouterDeps): DeepLinkRouter {
  return new DeepLinkRouterImpl(deps)
}
