import { errorMessage, hasBridge, openNoteWindow } from '@reflect/core'
import { deepLinkForRoute } from '@/lib/deep-links/format'
import { parseDeepLink } from '@/lib/deep-links/parse'
import { isMobileSurface } from '@/lib/platform-surface'
import type { Route } from '@/routing/route'

/**
 * ⌘-click → open the target in a secondary note window (Plan 06). The
 * helpers resolve a route or an in-note `reflect://` link to the shell's
 * `open_note_window` command; callers fall back to in-window navigation
 * whenever a helper answers false, so the modifier can never make a link do
 * nothing.
 */

/** The modifier shape shared by native and React synthetic mouse events. */
export interface NewWindowClickEvent {
  metaKey: boolean
  ctrlKey: boolean
  type: string
}

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
 * name, or a failed command): the caller then navigates in place, so a
 * modifier click degrades to a plain one instead of doing nothing.
 */
export async function openRouteInNewWindow(route: Route): Promise<boolean> {
  if (!hasBridge() || isMobileSurface()) {
    return false
  }
  const link = deepLinkForRoute(route)
  if (link === null) {
    return false
  }
  return openWindowFor(link)
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
  return openWindowFor(href)
}

async function openWindowFor(link: string): Promise<boolean> {
  try {
    await openNoteWindow(link)
    return true
  } catch (cause) {
    console.error('open in new window failed:', errorMessage(cause))
    return false
  }
}
