import type {
  BackgroundTaskToken,
  PersistenceFlushService,
  PlatformFacts,
  Unlisten,
} from '@reflect/core'
import type { WindowService } from './window-service.ts'
import type { AppLifecycleService } from './lifecycle-service.ts'

/**
 * When the app lands its dirty state: on quit and window close on desktop,
 * and on every move to the background on mobile.
 */
export interface QuitPolicyService {
  /**
   * Flush on window close (the macOS main window hides and stays alive),
   * on a deferred app quit (then confirm it), and on page unload (without
   * waiting). Does nothing outside the native shell.
   */
  installDesktopQuitPolicy(): Unlisten
  /**
   * Flush every time the page turns hidden or is torn down, inside a native
   * background task. One flush runs at a time; a new transition during it
   * queues one more.
   */
  installMobileBackgroundPolicy(): Unlisten
}

export interface QuitPolicyServiceDeps {
  readonly lifecycle: AppLifecycleService
  readonly window: WindowService
  readonly platform: PlatformFacts
  readonly persistenceFlush: PersistenceFlushService
}

class QuitPolicyServiceImpl implements QuitPolicyService {
  readonly #deps: QuitPolicyServiceDeps
  readonly #mainWindow: boolean

  constructor(deps: QuitPolicyServiceDeps) {
    this.#deps = deps
    this.#mainWindow = deps.window.isMainWindow()
  }

  installDesktopQuitPolicy(): Unlisten {
    const { lifecycle, window, platform, persistenceFlush } = this.#deps
    if (!platform.isNativeShell) {
      return () => {}
    }
    const removeClose = window.onCloseRequested(async (event) => {
      const shouldHide = platform.isMacosDesktop && this.#mainWindow
      if (shouldHide) {
        // Before any await: AppKit otherwise destroys the last window and the app exits.
        event.preventDefault()
      }
      try {
        if (shouldHide) {
          await window.hide()
        }
      } finally {
        await persistenceFlush.flushAll()
      }
    })
    // A failed flush still quits: refusing would trap the user.
    const removeQuit = lifecycle.subscribeQuitRequested(() => {
      void persistenceFlush.flushAll().then(() => {
        void lifecycle.confirmQuit()
      })
    })
    // Unload cannot wait, but writes sent before teardown still reach the shell.
    const removeUnload = lifecycle.subscribeBeforeUnload(() => {
      persistenceFlush.startFlushAll()
    })
    return () => {
      removeClose()
      removeQuit()
      removeUnload()
    }
  }

  installMobileBackgroundPolicy(): Unlisten {
    const { lifecycle, persistenceFlush } = this.#deps
    let inFlight: Promise<void> | null = null
    let rerun = false
    let hidden = lifecycle.isHidden()
    let transition = hidden ? 1 : 0
    let lastRequestedTransition = 0

    const runProtected = async (): Promise<void> => {
      let backgroundTask: BackgroundTaskToken | null = null
      try {
        backgroundTask = await lifecycle.beginBackgroundTask()
      } catch {
        // No native protection: the flush stays best-effort.
      }
      try {
        await persistenceFlush.flushAll()
      } finally {
        if (backgroundTask !== null) {
          try {
            await lifecycle.endBackgroundTask(backgroundTask)
          } catch {
            // The OS expiration handler also ends an outstanding task.
          }
        }
      }
    }

    const flush = (): void => {
      if (inFlight !== null) {
        rerun = true
        return
      }
      inFlight = runProtected()
        .catch(() => {})
        .finally(() => {
          inFlight = null
          if (rerun) {
            rerun = false
            flush()
          }
        })
    }

    const flushTransition = (): void => {
      if (lastRequestedTransition === transition) {
        return
      }
      lastRequestedTransition = transition
      flush()
    }
    const enterHidden = (): void => {
      if (!hidden) {
        hidden = true
        transition += 1
      }
      flushTransition()
    }

    const removeHidden = lifecycle.subscribeHidden(enterHidden)
    const removeVisible = lifecycle.subscribeVisible(() => {
      hidden = false
    })
    const removePageHide = lifecycle.subscribePageHide(enterHidden)
    return () => {
      removeHidden()
      removeVisible()
      removePageHide()
    }
  }
}

export function createQuitPolicyService(deps: QuitPolicyServiceDeps): QuitPolicyService {
  return new QuitPolicyServiceImpl(deps)
}
