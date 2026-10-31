/**
 * Clip to at most `max` characters, dropping the trailing partial word — the
 * whole-word cut shared by the AI title generators. Falls back to a hard cut
 * when the first word alone overflows.
 */
export function clipAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const clipped = text
    .slice(0, max)
    .replace(/\s+\S*$/, '')
    .trim()
  return clipped === '' ? text.slice(0, max).trim() : clipped
}
