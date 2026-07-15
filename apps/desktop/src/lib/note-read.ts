import { isAppError, isDaily, readNote } from '@reflect/core'

/**
 * The note's content, where a missing daily file reads as an empty note. Fresh
 * ordinary notes keep their one-time creation authority inside the live
 * document session; treating any missing ULID-shaped path as empty here would
 * let a stale action or history entry recreate an adopted/deleted file.
 */
export async function readNoteOrEmpty(path: string): Promise<string> {
  try {
    return await readNote(path)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound' && isDaily(path)) {
      return ''
    }
    throw cause
  }
}
