import { appendXPost, isAppError, readNote, writeNote, type XPostEnvelope } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/** Route an X post through the live daily document, or a revision-checked file write. */
export async function commitXPost(
  envelope: XPostEnvelope,
  path: string,
  generation: number,
): Promise<void> {
  const owner = openSession(path)
  if (owner !== null) {
    if (!(await owner.commitSourceEdit((source) => appendXPost(source, envelope)))) {
      throw new Error('Resolve or finish loading the daily note before saving X posts')
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
  const opened = openSession(path)
  if (opened !== null) {
    if (!(await opened.commitSourceEdit((current) => appendXPost(current, envelope)))) {
      throw new Error('The daily note is busy; X post remains queued')
    }
    return
  }
  const next = appendXPost(source ?? '', envelope)
  if (next !== source) await writeNote(path, next, generation, source)
}
