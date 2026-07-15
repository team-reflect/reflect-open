import { useEffect } from 'react'
import {
  errorMessage,
  isMobilePlatform,
  subscribeIndexWritten,
  subscribeWindowNavigate,
  windowBootstrap,
  type AppPlatform,
  type NoteWindowNavigation,
  type WindowBootstrap,
} from '@reflect/core'
import { requestNoteHeadingReveal } from '@/editor/editor-handle-registry'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { throttledInvalidateIndexQueries } from '@/lib/query-client'
import { trackSubscriptions } from '@/lib/subscriptions'
import {
  initialRouteForDeepLink,
  setInitialWindowRoute,
} from '@/lib/windows/initial-window-route'
import { isMainWindow } from '@/lib/windows/window-role'

/** The graph provider's channels for the note-window boot leg. */
export interface NoteWindowBootOptions {
  platform: AppPlatform
  /** Commit the adopted sessions (graph + index generations) as ready. */
  onAdopted: (boot: WindowBootstrap) => void
  /** Park the window on the error screen (never the chooser). */
  onFailed: (message: string) => void
}

function deliverWindowNavigation(
  navigation: NoteWindowNavigation,
  generation: number,
): void {
  if (navigation.headingReveal !== null) {
    requestNoteHeadingReveal(
      navigation.headingReveal.path,
      navigation.headingReveal.fragment,
      generation,
    )
  }
  dispatchDeepLink(navigation.deepLink)
}

/**
 * Boot leg for a secondary note window (⌘-click → new window, Plan 06): it
 * ADOPTS the main window's open session — never `graph_open`/`index_open`,
 * whose generation bumps would strand every command the main window has
 * pinned — and runs no index lifecycle of its own. The Rust `index:written`
 * broadcast (fired after the main window's applies commit) keeps this
 * window's index-backed queries fresh.
 *
 * The initial deep link seeds the router directly whenever it resolves
 * synchronously (⌘-click builds path-shaped links), so the window's first
 * workspace render is already the clicked note — no flash of today's daily
 * note. Only a target that needs the index (an id/title-shaped link) rides
 * the ordinary intake, buffering until DeepLinkProvider attaches.
 *
 * A no-op everywhere else (main window, mobile, browser dev).
 */
export function useNoteWindowBoot({ platform, onAdopted, onFailed }: NoteWindowBootOptions): void {
  useEffect(() => {
    if (isMobilePlatform(platform) || isMainWindow()) {
      return
    }
    let active = true
    const subscriptions = trackSubscriptions()
    void (async () => {
      try {
        const boot = await windowBootstrap()
        // The pending deep link is drained server-side by the bootstrap, so
        // act on it even if this effect was superseded (StrictMode's probe
        // mount) — the route slot and the intake both outlive the effect,
        // serving whichever mount survives.
        const seeded = initialRouteForDeepLink(boot.initialNavigation?.deepLink ?? null)
        if (seeded !== null) {
          const reveal = boot.initialNavigation?.headingReveal ?? null
          if (reveal !== null) {
            requestNoteHeadingReveal(reveal.path, reveal.fragment, boot.graph.generation)
          }
          setInitialWindowRoute(seeded)
        } else if (boot.initialNavigation !== null) {
          deliverWindowNavigation(boot.initialNavigation, boot.graph.generation)
        }
        await subscriptions.add(subscribeIndexWritten(throttledInvalidateIndexQueries))
        // (Rename follow-through lives in desktop-root — every window needs
        // it, not just this one.)
        // Re-⌘-clicking this window's target focuses it AND re-navigates it
        // there (it may have navigated elsewhere since it opened).
        await subscriptions.add(
          subscribeWindowNavigate((navigation) =>
            deliverWindowNavigation(navigation, boot.graph.generation),
          ),
        )
        if (!active) {
          return
        }
        onAdopted(boot)
      } catch (err) {
        if (active) {
          onFailed(errorMessage(err))
        }
      }
    })()
    return () => {
      active = false
      subscriptions.disposeAll()
    }
  }, [platform, onAdopted, onFailed])
}
