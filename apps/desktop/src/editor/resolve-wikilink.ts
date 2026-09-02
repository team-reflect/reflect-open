import type { WikilinkPayload, WikilinkResolution } from '@meowdown/core'
import { subjectDisplayTitle } from '@reflect/core'

/**
 * The wiki-link chip rule shared by every meowdown surface: `[[target|alias]]`
 * splits at its first `|` (both halves trimmed) into the target the click and
 * hover handlers receive and the label the chip shows, and a bare `[[A // B]]`
 * reads as its first segment. Pure: meowdown caches the result per parse.
 */
export function resolveWikilink({ target }: WikilinkPayload): WikilinkResolution | undefined {
  const pipe = target.indexOf('|')
  if (pipe !== -1) {
    return { target: target.slice(0, pipe).trim(), display: target.slice(pipe + 1).trim() }
  }
  const display = subjectDisplayTitle(target)
  return display === target ? undefined : { display }
}
