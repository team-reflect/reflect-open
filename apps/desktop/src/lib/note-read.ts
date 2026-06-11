import { isAppError, readNote } from '@reflect/core'

/**
 * The note's content, where a missing file reads as an empty note — the lazy
 * contract: dailies (and ⌘N notes) are valid frontmatter-toggle targets before
 * their file exists, and the toggle's write is what creates the file. Covers
 * the gap where the pane's session exists but can't take patches yet (still
 * loading) — its post-load reconcile then adopts our write like any external
 * change.
 */
export async function readNoteOrEmpty(path: string): Promise<string> {
  try {
    return await readNote(path)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}
