import { openSession } from '@/editor/open-documents'
import type { NoteSession } from '@/editor/note-session'

export interface NoteOperationRoutes<Result> {
  readonly open: (session: NoteSession) => Promise<Result>
  readonly closed: () => Promise<Result>
}

export type NoteSessionLookup = (path: string) => NoteSession | null

/**
 * Route note work to the live editor when one exists, otherwise to disk.
 * The open branch is authoritative: a refusal or failure is returned as-is
 * and never falls through to a disk write that could clobber its buffer.
 */
export async function routeNoteOperation<Result>(
  path: string,
  routes: NoteOperationRoutes<Result>,
  lookup: NoteSessionLookup = openSession,
): Promise<Result> {
  const session = lookup(path)
  return session === null ? await routes.closed() : await routes.open(session)
}

export interface NotePathOperationQueue {
  /** Serialize operations for one graph-relative path while allowing other paths to proceed. */
  run: <Result>(path: string, operation: () => Promise<Result>) => Promise<Result>
}

/** Create a graph-scoped, per-path operation queue for AI apply and Undo work. */
export function createNotePathOperationQueue(): NotePathOperationQueue {
  const tails = new Map<string, Promise<void>>()

  async function run<Result>(path: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = tails.get(path) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => {},
      () => {},
    )
    tails.set(path, tail)
    try {
      return await result
    } finally {
      if (tails.get(path) === tail) {
        tails.delete(path)
      }
    }
  }

  return { run }
}
