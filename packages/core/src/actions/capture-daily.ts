import { isAppError } from '../errors.ts'
import { readNote, writeNote } from '../graph/commands.ts'

/** Apply a capture edit to the current daily source, resolving only once it is saved. */
export type CaptureDailyEditor = (
  path: string,
  transform: (source: string) => string,
) => Promise<void>

/** Prefer the host's live document; otherwise require the disk revision we read. */
export async function editCaptureDaily(
  path: string,
  generation: number,
  transform: (source: string) => string,
  editor?: CaptureDailyEditor,
): Promise<void> {
  if (editor) {
    await editor(path, transform)
    return
  }
  let source: string | null
  try {
    source = await readNote(path, generation)
  } catch (cause) {
    if (!isAppError(cause) || cause.kind !== 'notFound') throw cause
    source = null
  }
  const updated = transform(source ?? '')
  if (updated !== (source ?? '')) {
    await writeNote(path, updated, generation, source)
  }
}
