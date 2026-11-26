import { useState } from 'react'
import type { NoteSession, NoteSessionSnapshot } from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The methods of a note session. A view renders from the snapshot, not from
 * the session's `get`.
 */
export type NoteSessionActions = Omit<NoteSession, 'get' | 'subscribe'>

/**
 * The session of the note at `path` and its snapshot. The session lives in
 * `NoteSessionService`: this hook holds no document state, and its
 * subscription tells the service that a view shows the note.
 *
 * Key the editor on the session's `id`, not the path: a rename moves the
 * session to a new path and the route follows.
 */
export function useNoteSession(path: string): [NoteSessionActions, NoteSessionSnapshot] {
  const { noteSessions } = useCoreServices()
  // While `path` is the same, the pane keeps its session: a rename moves the
  // session to its new path before the route follows.
  const [held, setHeld] = useState(() => ({ path, session: noteSessions.sessionFor(path) }))
  let { session } = held
  if (held.path !== path) {
    session = noteSessions.sessionFor(path)
    setHeld({ path, session })
  }
  return [session, useStore(session)]
}
