import { readNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Read an existing note without disturbing its editor session.
 *
 * An open session's live buffer is newer than disk and can be read without
 * reconciling pending native input (unlike `NoteEditorHandle.getMarkdown`). A
 * closed note falls back to a generation-pinned read so a graph switch cannot
 * return content from the newly active graph.
 */
export async function readExistingNoteSource(
  path: string,
  generation: number,
): Promise<string> {
  const session = openSession(path)
  if (session !== null) {
    const liveContent = session.liveContent()
    if (liveContent !== null) {
      // The index and open-document registry can briefly outlive an external
      // delete or iCloud eviction. Prove the generation-pinned file is still
      // locally readable before publishing a live buffer; the already-mounted
      // watcher guards changes that race this read.
      await readNote(path, generation)
      return liveContent
    }
  }
  return readNote(path, generation)
}
