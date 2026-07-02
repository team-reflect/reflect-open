import { dateFromDailyPath, errorMessage, indexNote, isDaily, parseNote } from '@reflect/core'
import { newNoteId } from '@/lib/create-note'
import { isIsoDate } from '@/lib/dates'
import { dailyDeepLink, noteDeepLink } from '@/lib/deep-links/format'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter'
import { startOperation } from '@/lib/operations'

/**
 * "Copy deep link" (the v1 `alt+mod+l` port): the clipboard gets the most
 * durable `reflect://` address the note can have. A daily note is addressed
 * by its date. A regular note is addressed by its frontmatter `id` — minted
 * here on first copy for notes that predate Plan 17's ids or were created
 * outside Reflect — so the link survives every rename; the id lands through
 * the session-or-disk frontmatter channel like pin and private do.
 */
export async function deepLinkForNote(path: string, generation: number): Promise<string> {
  if (isDaily(path)) {
    const date = dateFromDailyPath(path)
    // Calendar-validated like `routeForPath`: a daily/ file with an impossible
    // date (2026-02-31) routes as a plain note everywhere else, so it gets a
    // note address too — a date form would be a link the parser rejects.
    if (date !== null && isIsoDate(date)) {
      return dailyDeepLink(date)
    }
  }
  const source = await readNoteSource(path)
  // A blank `id:` counts as no id (same rule as the CLI's `reflect open`):
  // linking it would emit `reflect://note/`, which the parser rejects.
  const existing = parseNote({ path, source }).frontmatter.id
  if (existing !== undefined && existing.trim() !== '') {
    return noteDeepLink(existing)
  }
  const id = newNoteId()
  await commitNoteFrontmatter(path, { id }, generation)
  // Resolution reads the index, which trails local writes by a watcher
  // debounce — index the mint now so the copied link resolves immediately.
  // Best-effort: the watcher pass covers this on its own schedule anyway.
  try {
    await indexNote(path, { generation })
  } catch {
    // the copied link still works once the watcher reindexes the note
  }
  return noteDeepLink(id)
}

/**
 * The copy action as both entry points run it (Note actions, ⌘K command):
 * build the link, put it on the clipboard, and confirm through the operations
 * status line — the app's no-toast feedback channel.
 */
export async function runCopyDeepLink(path: string, generation: number): Promise<void> {
  let url: string
  try {
    url = await deepLinkForNote(path, generation)
  } catch (cause) {
    startOperation('Copying deep link').fail(errorMessage(cause))
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    startOperation('Deep link copied').done()
  } catch (cause) {
    startOperation('Copying deep link').fail(errorMessage(cause))
  }
}
