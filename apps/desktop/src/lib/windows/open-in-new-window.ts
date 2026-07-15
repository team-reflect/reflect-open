import {
  errorMessage,
  hasBridge,
  openNoteWindow,
  type NoteHeadingReveal,
  type NoteWindowNavigation,
} from '@reflect/core'
import { deepLinkForRoute } from '@/lib/deep-links/format'
import { parseDeepLink } from '@/lib/deep-links/parse'
import { isMobileSurface } from '@/lib/platform-surface'
import type { Route } from '@/routing/route'

/**
 * Open a target in a secondary note window (Plan 06). Modifier-click callers
 * and the selected-note command resolve a route or an in-note `reflect://`
 * link to the shell's `open_note_window` command. Modifier-click callers fall
 * back to in-window navigation whenever a helper answers false, so the
 * modifier can never make a link do nothing.
 */

/** The modifier shape shared by native and React synthetic mouse events. */
export interface NewWindowClickEvent {
  metaKey: boolean
  ctrlKey: boolean
  type: string
}

/** Coalesce double-clicks before the shell has registered its content-addressed window label. */
const pendingWindowOpens = new Map<string, Promise<boolean>>()

/**
 * Whether a link click asked for a new window (⌘-click; ctrl-click off mac).
 * Mouse events only: meowdown also fires link handlers for the Mod-Enter
 * keyboard follow, whose modifier is held *by definition* — treating it as a
 * new-window request would hijack every keyboard link follow.
 */
export function isNewWindowClick(event: NewWindowClickEvent | undefined): boolean {
  if (event === undefined || event.type.startsWith('key')) {
    return false
  }
  return event.metaKey || event.ctrlKey
}

/**
 * Open `route` in a secondary note window. False — never a throw — when this
 * surface can't (no shell, mobile, a route the deep-link grammar doesn't
 * name, or a failed command). Modifier-click callers then navigate in place,
 * so the gesture degrades to a plain click instead of doing nothing.
 */
export async function openRouteInNewWindow(
  route: Route,
  headingReveal?: NoteHeadingReveal,
): Promise<boolean> {
  if (!hasBridge() || isMobileSurface()) {
    return false
  }
  const link = deepLinkForRoute(route)
  if (link === null) {
    return false
  }
  return openWindowFor({ deepLink: link, headingReveal: headingReveal ?? null })
}

/**
 * Open an in-note `reflect://` link in a secondary window — only links that
 * *address* something (navigate / openNote). Capture links (append, task)
 * are writes, not places: a modifier click still dispatches them normally.
 * Same false-not-throw contract as {@link openRouteInNewWindow}.
 */
export async function openDeepLinkInNewWindow(href: string): Promise<boolean> {
  if (!hasBridge() || isMobileSurface()) {
    return false
  }
  const link = parseDeepLink(href)
  if (link === null || link.kind === 'capture') {
    return false
  }
  return openWindowFor({ deepLink: href, headingReveal: null })
}

async function openWindowFor(navigation: NoteWindowNavigation): Promise<boolean> {
  // Identical route/reveal requests coalesce while native window creation is
  // pending. Different headings intentionally remain distinct requests: the
  // shell dedupes by route and forwards the latest reveal to that one window.
  const requestKey = JSON.stringify(navigation)
  const pending = pendingWindowOpens.get(requestKey)
  if (pending !== undefined) {
    return pending
  }

  const opening = (async (): Promise<boolean> => {
    try {
      await openNoteWindow(navigation)
      return true
    } catch (cause) {
      console.error('open in new window failed:', errorMessage(cause))
      return false
    }
  })()
  pendingWindowOpens.set(requestKey, opening)
  void opening.finally(() => {
    if (pendingWindowOpens.get(requestKey) === opening) {
      pendingWindowOpens.delete(requestKey)
    }
  })
  return opening
}
