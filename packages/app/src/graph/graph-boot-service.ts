import {
  errorMessage,
  isMobilePlatform,
  type GraphSessionService,
  type LoggerService,
  type PathService,
  type PlatformFacts,
  type Unlisten,
} from '@reflect/core'
import type { DialogService } from '../app/dialog-service.ts'
import type { WindowService } from '../app/window-service.ts'
import { initialRouteForDeepLink } from '../navigation/deep-link-route.ts'
import type { DeepLinkRouter } from '../navigation/deep-link-router.ts'

/**
 * The window-aware graph flows of this webview over the core graph session:
 * the boot path, the opens and closes that end the session note windows
 * adopted, and the folder picker.
 */
export interface GraphBootService {
  /**
   * Start this webview's graph: follow the index lifecycle, then run the boot
   * path of the window. The desktop main window reopens the most recent graph
   * or parks on the chooser. A note window adopts the main window's sessions
   * and follows its deep links. A mobile window waits for the mobile
   * onboarding to open a graph. The returned function stops the boot.
   */
  boot(): Unlisten
  /**
   * Close the note windows, then open a graph by its root path. Resolves
   * true only when it reached 'ready'.
   */
  openRecent(root: string): Promise<boolean>
  /**
   * Close the note windows, then create and open a graph at an app-chosen
   * absolute path. Resolves true only on a confirmed open.
   */
  createGraphAt(root: string): Promise<boolean>
  /**
   * Show the OS folder picker, then open the chosen graph.
   */
  pickAndOpen(): Promise<void>
  /**
   * Close the note windows and the active graph, and show the graph chooser.
   */
  chooseGraph(): Promise<void>
  /**
   * Drop a graph from the recents list; the note windows close first when it is the open one.
   */
  forgetRecent(root: string): Promise<void>
  /**
   * Close the note windows, then move the open graph's directory to the OS
   * trash. Throws when the delete fails.
   */
  deleteGraph(): Promise<void>
}

export interface GraphBootServiceDeps {
  readonly graphSession: GraphSessionService
  readonly window: WindowService
  readonly dialog: DialogService
  readonly path: PathService
  readonly platform: PlatformFacts
  readonly deepLinkRouter: DeepLinkRouter
  readonly logger: LoggerService
}

class GraphBootServiceImpl implements GraphBootService {
  readonly #deps: GraphBootServiceDeps

  constructor(deps: GraphBootServiceDeps) {
    this.#deps = deps
  }

  #isMobile(): boolean {
    return isMobilePlatform(this.#deps.platform.appPlatform)
  }

  /**
   * Close every note window before a graph switch or delete replaces the
   * session they adopted. Must run BEFORE anything bumps the graph/index
   * generations: each child's close-requested flush lands against the
   * still-valid session. A no-op on mobile, where secondary windows don't exist.
   */
  async #closeSecondaryWindows(): Promise<void> {
    if (this.#isMobile()) {
      return
    }
    await this.#deps.window.closeSecondaryWindows()
  }

  boot(): Unlisten {
    const { graphSession, window } = this.#deps
    let active = true
    const unlisteners = [graphSession.attach()]

    if (!this.#isMobile() && window.isMainWindow()) {
      // Desktop main window: reopen the most recent graph so the app resumes
      // where the user left off, or park on the chooser.
      void (async () => {
        const list = await graphSession.loadRecents({ surfaceErrors: true })
        if (!active) {
          return
        }
        if (list.length > 0) {
          await this.openRecent(list[0]!.root)
        } else {
          graphSession.park(graphSession.getState().error)
        }
      })()
    } else if (!this.#isMobile()) {
      // A secondary note window ADOPTS the main window's open session, never
      // `graph_open`/`index_open`, whose generation bumps would strand every
      // command the main window has pinned, and runs no index lifecycle of
      // its own.
      void (async () => {
        try {
          const adopted = await window.bootstrap()
          // The shell drains the pending deep link on the read, so this
          // follows it even when the boot was stopped meanwhile.
          const stopLinks = this.#followWindowLinks(adopted.initialDeepLink)
          if (!active) {
            stopLinks()
            return
          }
          unlisteners.push(stopLinks)
          graphSession.adopt(adopted.graph, adopted.indexGeneration)
        } catch (err) {
          if (active) {
            // Off-main, 'choosing' renders as an error screen, never the
            // chooser: choosing here would re-root every other window.
            graphSession.park(errorMessage(err))
          }
        }
      })()
    }

    return () => {
      active = false
      for (const unlisten of unlisteners.splice(0)) {
        unlisten()
      }
    }
  }

  /**
   * Seed the note window's route from its initial deep link, then follow the
   * main window's requests to re-navigate it.
   */
  #followWindowLinks(initialDeepLink: string | null): Unlisten {
    const { window, deepLinkRouter } = this.#deps
    // The initial deep link seeds the router directly whenever it resolves
    // synchronously (⌘-click builds path-shaped links), so the window's
    // first workspace render is already the clicked note: no flash of
    // today's daily note. Only a target that needs the index (an
    // id/title-shaped link) rides the ordinary intake, buffering until
    // DeepLinkProvider attaches.
    const seeded = initialRouteForDeepLink(initialDeepLink)
    if (seeded !== null) {
      deepLinkRouter.setInitialWindowRoute(seeded)
    } else if (initialDeepLink !== null) {
      deepLinkRouter.dispatch(initialDeepLink)
    }
    // Re-⌘-clicking this window's target focuses it AND re-navigates it
    // there (it may have navigated elsewhere since it opened).
    return window.subscribeNavigate((url) => {
      deepLinkRouter.dispatch(url)
    })
  }

  async openRecent(root: string): Promise<boolean> {
    if (this.#deps.window.isMainWindow()) {
      await this.#closeSecondaryWindows() // before graph_open bumps the session
    }
    return await this.#deps.graphSession.openRecent(root)
  }

  async createGraphAt(root: string): Promise<boolean> {
    if (this.#deps.window.isMainWindow()) {
      await this.#closeSecondaryWindows() // before the open bumps the session
    }
    return await this.#deps.graphSession.createGraphAt(root)
  }

  /**
   * On a macOS first run (no recents yet), start the folder picker in iCloud
   * Drive, the recommended home for a graph (Plan 21): notes back up
   * automatically and the iOS app's container lives there too. Suggestion
   * only: the user can navigate anywhere, and once they have a graph the
   * picker reverts to the OS default (their last-used location). Best-effort:
   * a resolution failure (or a signed-out account's missing folder, which the
   * open panel falls back from on its own) must never block picking.
   */
  async #pickerDefaultPath(hasRecents: boolean): Promise<{ defaultPath: string } | null> {
    if (hasRecents || !this.#deps.platform.isMacosDesktop) {
      return null
    }
    try {
      return { defaultPath: await this.#deps.path.icloudDriveRoot() }
    } catch (err) {
      this.#deps.logger.warn('iCloud Drive picker suggestion failed:', errorMessage(err))
      return null
    }
  }

  async pickAndOpen(): Promise<void> {
    const { graphSession, dialog } = this.#deps
    let selected: string | null = null
    try {
      selected = await dialog.pickFolder({
        title: 'Choose a graph folder',
        ...(await this.#pickerDefaultPath(graphSession.getState().recents.length > 0)),
      })
    } catch (err) {
      graphSession.reportError(errorMessage(err))
      return
    }
    if (selected) {
      await this.openRecent(selected)
    }
  }

  async chooseGraph(): Promise<void> {
    const { graphSession, window, logger } = this.#deps
    if (!window.isMainWindow()) {
      logger.warn('switching graphs is only available from the main window')
      return
    }
    await this.#closeSecondaryWindows() // the session they adopted is ending
    await graphSession.close()
    await graphSession.loadRecents({ surfaceErrors: true })
  }

  async forgetRecent(root: string): Promise<void> {
    const { graphSession } = this.#deps
    if (graphSession.getState().graph?.root === root) {
      // Forgetting the ACTIVE graph ends the session its note windows
      // adopted: same close-first rule as switch/delete.
      await this.#closeSecondaryWindows()
    }
    await graphSession.forgetRecent(root)
  }

  async deleteGraph(): Promise<void> {
    const { graphSession, window } = this.#deps
    if (window.isMainWindow() && graphSession.getState().graph !== null) {
      await this.#closeSecondaryWindows() // before the delete invalidates the session
    }
    await graphSession.deleteGraph()
  }
}

export function createGraphBootService(deps: GraphBootServiceDeps): GraphBootService {
  return new GraphBootServiceImpl(deps)
}
