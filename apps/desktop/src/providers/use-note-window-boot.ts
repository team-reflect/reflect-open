import { useEffect } from 'react'
import {
  errorMessage,
  isMobilePlatform,
  subscribeIndexWritten,
  windowBootstrap,
  type AppPlatform,
  type WindowBootstrap,
} from '@reflect/core'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { throttledInvalidateIndexQueries } from '@/lib/query-client'
import { isMainWindow } from '@/lib/window-role'

/** The graph provider's channels for the note-window boot leg. */
export interface NoteWindowBootOptions {
  platform: AppPlatform
  /** Commit the adopted sessions (graph + index generations) as ready. */
  onAdopted: (boot: WindowBootstrap) => void
  /** Park the window on the error screen (never the chooser). */
  onFailed: (message: string) => void
}

/**
 * Boot leg for a secondary note window (⌘-click → new window, Plan 06): it
 * ADOPTS the main window's open session — never `graph_open`/`index_open`,
 * whose generation bumps would strand every command the main window has
 * pinned — and runs no index lifecycle of its own. The Rust `index:written`
 * broadcast (fired after the main window's applies commit) keeps this
 * window's index-backed queries fresh, and the window's initial deep link
 * rides the ordinary intake, buffering until the workspace's
 * DeepLinkProvider attaches.
 *
 * A no-op everywhere else (main window, mobile, browser dev).
 */
export function useNoteWindowBoot({ platform, onAdopted, onFailed }: NoteWindowBootOptions): void {
  useEffect(() => {
    if (isMobilePlatform(platform) || isMainWindow()) {
      return
    }
    let active = true
    let unlistenIndexWritten: (() => void) | null = null
    void (async () => {
      try {
        const boot = await windowBootstrap()
        // The pending deep link is drained server-side by the bootstrap, so
        // dispatch it even if this effect was superseded (StrictMode's probe
        // mount) — the intake buffers it for whichever mount survives.
        if (boot.initialDeepLink !== null) {
          dispatchDeepLink(boot.initialDeepLink)
        }
        const unlisten = await subscribeIndexWritten(throttledInvalidateIndexQueries)
        if (!active) {
          unlisten()
          return
        }
        unlistenIndexWritten = unlisten
        onAdopted(boot)
      } catch (err) {
        if (active) {
          onFailed(errorMessage(err))
        }
      }
    })()
    return () => {
      active = false
      unlistenIndexWritten?.()
    }
  }, [platform, onAdopted, onFailed])
}
