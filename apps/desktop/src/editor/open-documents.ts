import type { NoteSession } from './note-session'

/**
 * The open note documents, as one app-global service (foundations hardening,
 * post-Plan-07). This consolidates what used to be two parallel registries —
 * a quit-flush list and a path→session lookup — because they were both views
 * of the same fact: *these documents are open right now*.
 *
 * Consumers:
 * - **Quit teardown** ({@link flushOpenDocuments}): every buffer flushes, and
 *   each document's settle-time work (pending title renames) fires and is
 *   awaited — the webview must not die before the writes land. React unmount
 *   effects never run on the quit paths, which is why this lives outside React.
 * - **Work that outlives a pane** ({@link openSession}): the rename
 *   coordinator's alias placement discovers whether its note is open (possibly
 *   *reopened* in a new pane) and routes through the live session's frontmatter
 *   channel instead of racing the disk under a dirty buffer.
 */

export interface OpenDocument {
  session: NoteSession
  /** Fire pending settle-time work (title renames) now. */
  settle?: () => void
  /** Resolves once fired settle-time work has landed. */
  settled?: () => Promise<void>
}

const documents = new Map<string, OpenDocument>()

/** Register an open document (keyed by its session's path); returns the unregister. */
export function registerOpenDocument(document: OpenDocument): () => void {
  const path = document.session.path
  documents.set(path, document)
  return () => {
    if (documents.get(path) === document) {
      documents.delete(path)
    }
  }
}

/** The live session for `path`, if that note is open in some pane. */
export function openSession(path: string): NoteSession | null {
  return documents.get(path)?.session ?? null
}

/**
 * Flush every open buffer, fire each document's pending settle-time work, and
 * settle once all of it has landed. Failures are surfaced per-document by the
 * save pipeline already; teardown must proceed past them, so rejections are
 * absorbed, never re-thrown.
 */
export async function flushOpenDocuments(): Promise<void> {
  await Promise.allSettled(
    [...documents.values()].map(async (document) => {
      await document.session.flush()
      // Settle after the flush so the rename tracker has seen the final title;
      // settle() appends the rewrite synchronously, settled() awaits it.
      document.settle?.()
      await document.settled?.()
    }),
  )
}
