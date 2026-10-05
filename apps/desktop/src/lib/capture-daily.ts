import { isAppError, readNote, writeNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents.ts'

/** Save a capture through the open daily document, or a revision-checked file write. */
export async function commitCaptureDaily(
  path: string,
  generation: number,
  transform: (source: string) => string,
  isStale: () => boolean = () => false,
): Promise<void> {
  if (isStale()) throw new Error('Capture graph session changed')
  const owner = openSession(path)
  if (owner !== null) {
    if (!(await owner.commitSourceEdit(transform))) {
      throw new Error('The daily note is busy; capture remains queued')
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
  if (isStale()) throw new Error('Capture graph session changed')
  const opened = openSession(path)
  if (opened !== null) {
    if (!(await opened.commitSourceEdit(transform))) {
      throw new Error('The daily note is busy; capture remains queued')
    }
    return
  }
  const updated = transform(source ?? '')
  if (updated !== (source ?? '')) await writeNote(path, updated, generation, source)
}
