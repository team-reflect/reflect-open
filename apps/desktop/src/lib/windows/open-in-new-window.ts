import { errorMessage, openNoteWindow } from '@reflect/core'
import { deepLinkForRoute } from '@/lib/deep-links/format'
import { parseDeepLink } from '@/lib/deep-links/parse'
import { isNativeShell } from '@/lib/platform'
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
 * Whether a mouse click asked for a new window (⌘-click; ctrl-click off
 * mac). Keyboard events always answer false: a keyboard follow's intent is
 * meowdown's `mod` flag, combined in {@link followWantsNewWindow}. UI
 * boundaries turn their gesture into the explicit `openInNewWindow` flag
 * that the navigation chain carries.
 */
export function isNewWindowClick(event: NewWindowClickEvent | undefined): boolean {
  if (event === undefined || event.type.startsWith('key')) {
    return false
  }
  return event.metaKey || event.ctrlKey
}

/**
 * The new-window intent of a meowdown follow: the `mod` flag (the platform
 * modifier held beyond the follow's own trigger), or a modifier mouse click.
 */
export function followWantsNewWindow(payload: {
  event: NewWindowClickEvent
  mod: boolean
}): boolean {
  return payload.mod || isNewWindowClick(payload.event)
}

/**
 * Open `route` in a secondary note window. False — never a throw — when this
 * surface can't (no shell, mobile, a route the deep-link grammar doesn't
 * name, or a failed command). Modifier-click callers then navigate in place,
 * so the gesture degrades to a plain click instead of doing nothing.
 */
export async function openRouteInNewWindow(route: Route): Promise<boolean> {
  if (!isNativeShell() || isMobileSurface()) {
    return false
  }
  const link = deepLinkForRoute(route)
  if (link === null) {
    return false
  }
  return await openWindowFor(link)
}

/**
 * Open an in-note `reflect://` link in a secondary window — only links that
 * *address* something (navigate / openNote). Capture links (append, task)
 * are writes, not places: a modifier click still dispatches them normally.
 * Same false-not-throw contract as {@link openRouteInNewWindow}.
 */
export async function openDeepLinkInNewWindow(href: string): Promise<boolean> {
  if (!isNativeShell() || isMobileSurface()) {
    return false
  }
  const link = parseDeepLink(href)
  if (link === null || link.kind === 'capture') {
    return false
  }
  return await openWindowFor(href)
}

async function openWindowFor(link: string): Promise<boolean> {
  const pending = pendingWindowOpens.get(link)
  if (pending !== undefined) {
    return await pending
  }

  const opening = (async (): Promise<boolean> => {
    try {
      await openNoteWindow(link)
      return true
    } catch (cause) {
      console.error('open in new window failed:', errorMessage(cause))
      return false
    }
  })()
  pendingWindowOpens.set(link, opening)
  void opening.finally(() => {
    if (pendingWindowOpens.get(link) === opening) {
      pendingWindowOpens.delete(link)
    }
  })
  return await opening
}
