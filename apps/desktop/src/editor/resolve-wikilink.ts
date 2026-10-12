import { useMemo } from 'react'
import type { WikilinkResolver } from '@meowdown/core'
import { displayNoteTitle, type DateFormat } from '@reflect/core'
import { formatDayLabel, isIsoDate } from '@/lib/dates.ts'
import { useDateFormat } from '@/hooks/use-date-format.ts'

/**
 * The wiki-link chip rule shared by every meowdown surface: `[[target|alias]]`
 * splits at its first `|` (both halves trimmed) into the target the click and
 * hover handlers receive and the label the chip shows. A target without an
 * alias (or with a blank one) reads as the note it names: a date as its day
 * per the date-format setting, anything else as its display title, so
 * `[[A // B]]` shows its first segment. The resolver is pure: meowdown caches
 * the result per parse.
 */
export function createWikilinkResolver(dateFormat: DateFormat): WikilinkResolver {
  return ({ target }) => {
    const pipe = target.indexOf('|')
    const canonical = (pipe === -1 ? target : target.slice(0, pipe)).trim()
    const alias = pipe === -1 ? '' : target.slice(pipe + 1).trim()
    const display =
      alias !== ''
        ? alias
        : isIsoDate(canonical)
          ? formatDayLabel(canonical, dateFormat)
          : displayNoteTitle(canonical)
    if (pipe === -1 && display === canonical) {
      return
    }
    return { target: canonical, display }
  }
}

/**
 * {@link createWikilinkResolver} bound to the user's date-format setting. The
 * resolver keeps its identity until the setting changes, because a new
 * identity makes meowdown resolve every chip again.
 */
export function useWikilinkResolver(): WikilinkResolver {
  const dateFormat = useDateFormat()
  return useMemo(() => createWikilinkResolver(dateFormat), [dateFormat])
}
