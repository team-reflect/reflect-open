import {
  availableNotePath,
  dailyPath,
  isAppError,
  readNote,
  slugForTitle,
  writeNote,
} from '@reflect/core'
import { newNoteSource } from '@/lib/create-note'
import { flushOpenDocuments } from '@/editor/open-documents'

/**
 * Quick capture (Plan 19, step 9): both actions write through the same core
 * setters as everything else, so the mobile write echo (decision 5) carries
 * them into the index, query invalidation, and the sync dirty mark.
 *
 * Append flushes open documents first: today's note is usually open in the
 * editor behind the sheet, and a write under a *dirty* session would park it
 * as a conflict. Flushed clean, the write's echo reloads the session
 * imperatively instead — the appended text just appears.
 */

/**
 * Append `text` to a day's note, separated by a blank line; a missing file
 * (the lazy-daily contract) starts with just the text. No-op on blank input.
 */
export async function appendToDaily(
  date: string,
  text: string,
  generation: number,
): Promise<void> {
  const trimmed = text.trim()
  if (trimmed === '') {
    return
  }
  await flushOpenDocuments()
  const path = dailyPath(date)
  let existing = ''
  try {
    existing = await readNote(path)
  } catch (err) {
    if (!(isAppError(err) && err.kind === 'notFound')) {
      throw err
    }
  }
  const base = existing.replace(/\s+$/u, '')
  const contents = base === '' ? `${trimmed}\n` : `${base}\n\n${trimmed}\n`
  await writeNote(path, contents, generation)
}

/**
 * Create a note from captured text: the first line becomes the title (and
 * the slug filename), the rest the body. Returns the new path for
 * navigation, or `null` on blank input.
 */
export async function createNoteFromCapture(
  text: string,
  generation: number,
): Promise<string | null> {
  const trimmed = text.trim()
  if (trimmed === '') {
    return null
  }
  const newlineAt = trimmed.indexOf('\n')
  const title = (newlineAt === -1 ? trimmed : trimmed.slice(0, newlineAt)).trim()
  const body = newlineAt === -1 ? '' : trimmed.slice(newlineAt + 1).trim()
  const path = await availableNotePath(slugForTitle(title))
  const source = newNoteSource(title)
  await writeNote(path, body === '' ? source : `${source}\n${body}\n`, generation)
  return path
}
