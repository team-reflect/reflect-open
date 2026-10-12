import { dateFromDailyPath, displayNoteTitle, type DateFormat } from '@reflect/core'
import { formatDayLabel } from '@/lib/dates.ts'

/** The two fields that decide how a note is named. */
export interface LabeledNote {
  path: string
  title: string
}

/**
 * The name a note goes by wherever it is listed or linked: a daily note reads
 * as its day per the date-format setting (`Tue, June 9th, 2026`), any other
 * note as its display title.
 */
export function formatNoteLabel(note: LabeledNote, dateFormat: DateFormat): string {
  const date = dateFromDailyPath(note.path)
  return date !== null ? formatDayLabel(date, dateFormat) : displayNoteTitle(note.title)
}
