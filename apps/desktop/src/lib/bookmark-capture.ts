import {
  appendBookmark,
  isAppError,
  readNote,
  writeNote,
  type BookmarkEnvelope,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/** Route a bookmark through the live daily document, or a revision-checked file write. */
export async function commitBookmark(
  envelope: BookmarkEnvelope,
  path: string,
  generation: number,
): Promise<void> {
  const owner = openSession(path, generation)
  if (owner !== null) {
    if (!(await owner.commitSourceEdit((source) => appendBookmark(source, envelope)))) {
      throw new Error('Resolve or finish loading the daily note before saving bookmarks')
    }
    return
  }
  let source: string | null
  try {
    source = await readNote(path, generation)
  } catch (cause) {
    if (!isAppError(cause) || cause.kind !== 'notFound') throw cause
    source = null
  }
  // A document may have opened while the filesystem read was pending.
  const opened = openSession(path, generation)
  if (opened !== null) {
    if (!(await opened.commitSourceEdit((current) => appendBookmark(current, envelope)))) {
      throw new Error('The daily note is busy; bookmark remains queued')
    }
    return
  }
  const next = appendBookmark(source ?? '', envelope)
  if (next !== source) await writeNote(path, next, generation, source)
}
