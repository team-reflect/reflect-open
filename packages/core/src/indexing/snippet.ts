/** Snippet text for note list rows. */

const PREVIEW_MAX_LENGTH = 120

/**
 * `text.slice(0, maxLength)` that never ends on a lone UTF-16 high surrogate.
 * A raw code-unit slice can cut an astral character — an emoji, or the
 * mathematical-alphanumeric letters people paste from Twitter — in half,
 * leaving a dangling high surrogate. That half-character survives `JSON.stringify`
 * as a lone `\udXXX`, which the Rust index writer's serde_json rejects with
 * "unexpected end of hex escape", and the whole note is dropped from the rebuilt
 * index. Trimming the orphaned surrogate keeps the slice a single code unit
 * shorter and always well-formed.
 */
function sliceWithoutSplittingSurrogate(text: string, maxLength: number): string {
  const end = Math.min(maxLength, text.length)
  const lastCode = text.charCodeAt(end - 1)
  const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff
  return text.slice(0, isLoneHighSurrogate ? end - 1 : end)
}

/**
 * A list-row preview of a note from the index's plain text. `buildPlainText`
 * collapses all whitespace to single spaces — there are no lines to split on —
 * so the preview is the collapsed text with the title dropped when it leads it
 * (heading *text* survives the markup cuts, so most notes open with their own
 * title — pure noise next to a Subject column). The strip is whole-word: a
 * title that is merely a prefix of the first word (`Health` / `Healthy…`)
 * stays put. Raw multi-line input is collapsed the same way first, so the
 * function is total over both the stored text and any fresher source.
 */
export function previewSnippet(
  text: string,
  title: string,
  maxLength = PREVIEW_MAX_LENGTH,
): string {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim()
  const foldedTitle = title.replaceAll(/\s+/g, ' ').trim()
  let body = collapsed
  if (foldedTitle !== '') {
    if (body === foldedTitle) {
      body = ''
    } else if (body.startsWith(`${foldedTitle} `)) {
      body = body.slice(foldedTitle.length + 1)
    }
  }
  return body.length <= maxLength
    ? body
    : `${sliceWithoutSplittingSurrogate(body, maxLength).trimEnd()}…`
}
