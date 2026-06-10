import type { NoteSession } from './note-session'

/**
 * The live note sessions by path (Plan 07b). Lets work that outlives a pane —
 * the rename coordinator's alias placement — discover that its note has been
 * *reopened* and route the write through the live session's frontmatter
 * channel instead of the disk: a direct disk write under a dirty reopened
 * buffer would park a conflict caused by our own background work, and
 * "keep mine" would silently drop the alias.
 */

const sessions = new Map<string, NoteSession>()

/** Register the session for its path; returns the unregister. */
export function registerSession(session: NoteSession): () => void {
  sessions.set(session.path, session)
  return () => {
    if (sessions.get(session.path) === session) {
      sessions.delete(session.path)
    }
  }
}

/** The currently-open session for `path`, if any. */
export function liveSession(path: string): NoteSession | null {
  return sessions.get(path) ?? null
}
