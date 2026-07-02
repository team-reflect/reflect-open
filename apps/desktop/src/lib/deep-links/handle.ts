import {
  captureInboxSpool,
  errorMessage,
  resolveNoteTarget,
  textCaptureEnvelopeSchema,
} from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { routeForPath, type Route } from '@/routing/route'
import { parseDeepLink } from '@/lib/deep-links/parse'

/** What acting on a deep link needs from the open graph session. */
export interface DeepLinkIo {
  navigate: (route: Route) => void
  /** `GraphInfo.generation` — pins the capture spool to the issuing graph. */
  generation: number
  /**
   * Whether this graph session ended while the handler awaited (graph
   * switch). Note resolution queries whichever index is open when it runs, so
   * a stale result must be dropped, never navigated — it may name a homonym
   * note in the newly opened graph. (The capture path needs no gate: the
   * spool write is generation-pinned in Rust and fails loudly when stale.)
   */
  isStale?: () => boolean
}

/**
 * Act on one incoming `reflect://` URL: navigation links navigate (a note
 * target resolving through the index first), capture links spool an envelope
 * into `.reflect/inbox/` for the watcher-triggered drain to materialize.
 * Every outcome that isn't a navigation surfaces on the operations status
 * line — an outside-world input must never crash or silently vanish.
 */
export async function handleDeepLink(url: string, io: DeepLinkIo): Promise<void> {
  const link = parseDeepLink(url)
  if (link === null) {
    startOperation('Opening link').fail(`Unrecognized link: ${truncate(url)}`)
    return
  }
  switch (link.kind) {
    case 'navigate':
      io.navigate(link.route)
      return
    case 'openNote': {
      let path: string | null
      try {
        path = await resolveNoteTarget(link.target)
      } catch (cause) {
        startOperation('Opening link').fail(errorMessage(cause))
        return
      }
      if (io.isStale?.() === true) {
        return // the graph switched mid-resolve; the result answers the wrong graph
      }
      if (path === null) {
        startOperation('Opening link').fail(`Note not found: ${truncate(link.target)}`)
        return
      }
      io.navigate(routeForPath(path))
      return
    }
    case 'capture': {
      const label = link.capture === 'task' ? 'Task added to today' : 'Added to today'
      try {
        // The URL parser enforces the same text constraints, so this parse is
        // belt-and-braces — but it is fallible, and a schema tightening must
        // surface like every other failure here, not escape the handler.
        const envelope = textCaptureEnvelopeSchema.parse({
          version: 1,
          id: crypto.randomUUID(),
          kind: link.capture,
          text: link.text,
          capturedAt: new Date().toISOString(),
          source: 'deep-link',
        })
        await captureInboxSpool(`${envelope.id}.json`, JSON.stringify(envelope), io.generation)
      } catch (cause) {
        startOperation('Saving capture').fail(errorMessage(cause))
        return
      }
      startOperation(label).done()
    }
  }
}

/** Status-line-sized excerpt of an untrusted URL or target. */
function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value
}
