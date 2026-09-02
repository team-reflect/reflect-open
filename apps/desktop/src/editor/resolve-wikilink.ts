import type { WikilinkPayload, WikilinkResolution } from '@meowdown/core'
import { displayNoteTitle } from '@reflect/core'

/**
 * The wiki-link chip rule shared by every meowdown surface: `[[target|alias]]`
 * splits at its first `|` (both halves trimmed) into the target the click and
 * hover handlers receive and the label the chip shows, and a target without an
 * alias (or with a blank one) reads as its display title, so `[[A // B]]` shows
 * its first segment. Pure: meowdown caches the result per parse.
 */
export function resolveWikilink({ target }: WikilinkPayload): WikilinkResolution | undefined {
  const pipe = target.indexOf('|')
  const canonical = (pipe === -1 ? target : target.slice(0, pipe)).trim()
  const alias = pipe === -1 ? '' : target.slice(pipe + 1).trim()
  const display = alias === '' ? displayNoteTitle(canonical) : alias
  if (pipe === -1 && display === canonical) {
    return undefined
  }
  return { target: canonical, display }
}
