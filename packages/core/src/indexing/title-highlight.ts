import { foldKey } from '../markdown'
import { HIGHLIGHT_END, HIGHLIGHT_START, parseHighlights } from './search'
import { titleRecallTerms } from './search-query'

interface TextRange {
  readonly start: number
  readonly end: number
}

interface FoldedText {
  readonly value: string
  readonly sourceSpans: TextRange[]
}

/** Fold like the index while mapping expansions (`İ` → `i̇`) back to source text. */
function foldWithSourceSpans(value: string): FoldedText {
  const trimStart = value.length - value.trimStart().length
  const sourceSpans: TextRange[] = []
  let sourceOffset = trimStart

  for (const character of value.trim()) {
    const foldedCharacter = character.toLowerCase()
    const sourceEnd = sourceOffset + character.length
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourceSpans.push({ start: sourceOffset, end: sourceEnd })
    }
    sourceOffset = sourceEnd
  }

  return { value: foldKey(value), sourceSpans }
}

function findRanges(
  foldedTitle: FoldedText,
  literal: string,
  anywhere: boolean,
): TextRange[] {
  const ranges: TextRange[] = []
  let searchFrom = 0

  while (searchFrom < foldedTitle.value.length) {
    const matchStart = foldedTitle.value.indexOf(literal, searchFrom)
    if (matchStart === -1) {
      break
    }
    const matchEnd = matchStart + literal.length
    const atWordStart = matchStart === 0 || foldedTitle.value[matchStart - 1] === ' '
    const startSpan = foldedTitle.sourceSpans[matchStart]
    const endSpan = foldedTitle.sourceSpans[matchEnd - 1]
    if ((anywhere || atWordStart) && startSpan !== undefined && endSpan !== undefined) {
      ranges.push({ start: startSpan.start, end: endSpan.end })
    }
    searchFrom = matchEnd
  }

  return ranges
}

function titleRecallRanges(title: string, query: string): TextRange[] {
  const terms = titleRecallTerms(query)
  if (terms.length === 0 || title === '') {
    return []
  }

  const foldedTitle = foldWithSourceSpans(title)
  const termRanges = terms.map((term) =>
    findRanges(foldedTitle, term.value, term.anywhere),
  )
  if (termRanges.some((ranges) => ranges.length === 0)) {
    return []
  }

  if (terms.length > 1) {
    const phraseRanges = findRanges(
      foldedTitle,
      terms.map((term) => term.value).join(' '),
      terms[0]!.anywhere,
    )
    if (phraseRanges.length > 0) {
      return phraseRanges
    }
  }

  return termRanges.flat()
}

function ftsRanges(title: string, highlightedTitle: string | null): TextRange[] {
  if (highlightedTitle === null) {
    return []
  }

  const ranges: TextRange[] = []
  let plainTitle = ''
  let offset = 0
  for (const segment of parseHighlights(highlightedTitle)) {
    const end = offset + segment.text.length
    if (segment.highlighted) {
      ranges.push({ start: offset, end })
    }
    plainTitle += segment.text
    offset = end
  }
  return plainTitle === title ? ranges : []
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort(
    (first, second) => first.start - second.start || first.end - second.end,
  )
  const merged: TextRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      }
    } else {
      merged.push(range)
    }
  }
  return merged
}

function markRanges(title: string, ranges: TextRange[]): string {
  let marked = ''
  let previousEnd = 0
  for (const range of mergeRanges(ranges)) {
    marked += title.slice(previousEnd, range.start)
    marked += `${HIGHLIGHT_START}${title.slice(range.start, range.end)}${HIGHLIGHT_END}`
    previousEnd = range.end
  }
  return marked + title.slice(previousEnd)
}

/** Merge FTS token matches and title-recall matches into one marked title. */
export function highlightTitle(
  title: string,
  query: string,
  ftsHighlightedTitle: string | null,
): string {
  return markRanges(title, [
    ...ftsRanges(title, ftsHighlightedTitle),
    ...titleRecallRanges(title, query),
  ])
}
