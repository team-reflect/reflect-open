import { SearchQuery, type SearchResult } from 'prosemirror-search'
import type { EditorState } from 'prosemirror-state'

type ProseMirrorNode = EditorState['doc']
type ProseMirrorMark = ProseMirrorNode['marks'][number]

const SYNTAX_MARK_NAMES: ReadonlySet<string> = new Set([
  'mdMark',
  'mdLinkUri',
  'mdLinkTitle',
])

const ATOM_MARK_NAMES: ReadonlySet<string> = new Set([
  'mdWikilink',
  'mdImage',
  'mdFile',
  'mdMath',
])

interface DisplaySegment {
  readonly displayFrom: number
  readonly displayTo: number
  readonly documentFrom: number
  readonly documentTo: number
  readonly atom: boolean
}

interface TextblockProjection {
  readonly text: string
  readonly segments: readonly DisplaySegment[]
}

interface MutableAtomRun {
  readonly mark: ProseMirrorMark
  readonly documentFrom: number
  documentTo: number
}

/** Display-mode options for a note-local text query. */
export interface NoteFindQueryOptions {
  /** Include Markdown syntax that the editor's `show` mode makes visible. */
  readonly includeSyntax?: boolean
}

function atomMark(
  marks: readonly ProseMirrorMark[],
  includeSyntax: boolean,
): ProseMirrorMark | null {
  return (
    marks.find(
      (mark) =>
        ATOM_MARK_NAMES.has(mark.type.name) &&
        !(includeSyntax && mark.type.name === 'mdMath'),
    ) ?? null
  )
}

function atomDisplayText(mark: ProseMirrorMark): string {
  switch (mark.type.name) {
    case 'mdWikilink':
      return String(mark.attrs['display'] || mark.attrs['target'] || '')
    case 'mdImage':
      return String(mark.attrs['alt'] || '')
    case 'mdFile':
      return String(mark.attrs['name'] || '')
    case 'mdMath':
      return String(mark.attrs['formula'] || '')
    default:
      return ''
  }
}

function projectTextblock(
  textblock: ProseMirrorNode,
  contentStart: number,
  includeSyntax: boolean,
): TextblockProjection {
  const segments: DisplaySegment[] = []
  let text = ''
  let pendingAtom: MutableAtomRun | null = null

  function appendSegment(
    displayText: string,
    documentFrom: number,
    documentTo: number,
    atom: boolean,
  ): void {
    if (displayText.length === 0) {
      return
    }
    const displayFrom = text.length
    text += displayText
    segments.push({
      displayFrom,
      displayTo: text.length,
      documentFrom,
      documentTo,
      atom,
    })
  }

  function flushAtom(): void {
    if (pendingAtom === null) {
      return
    }
    appendSegment(
      atomDisplayText(pendingAtom.mark),
      pendingAtom.documentFrom,
      pendingAtom.documentTo,
      true,
    )
    pendingAtom = null
  }

  textblock.forEach((child, offset) => {
    if (!child.isText || !child.text) {
      flushAtom()
      return
    }

    const documentFrom = contentStart + offset
    const documentTo = documentFrom + child.nodeSize
    const childAtom = atomMark(child.marks, includeSyntax)
    if (childAtom !== null) {
      if (pendingAtom?.mark === childAtom) {
        pendingAtom.documentTo = documentTo
      } else {
        flushAtom()
        pendingAtom = { mark: childAtom, documentFrom, documentTo }
      }
      return
    }

    flushAtom()
    if (
      includeSyntax ||
      !child.marks.some((mark) => SYNTAX_MARK_NAMES.has(mark.type.name))
    ) {
      appendSegment(child.text, documentFrom, documentTo, false)
    }
  })
  flushAtom()

  return { text, segments }
}

function documentStartFor(
  segments: readonly DisplaySegment[],
  displayPosition: number,
): number | null {
  const segment = segments.find(
    (candidate) =>
      displayPosition >= candidate.displayFrom && displayPosition < candidate.displayTo,
  )
  if (segment === undefined) {
    return null
  }
  return segment.atom
    ? segment.documentFrom
    : segment.documentFrom + displayPosition - segment.displayFrom
}

function documentEndFor(
  segments: readonly DisplaySegment[],
  displayPosition: number,
): number | null {
  const segment = segments.find(
    (candidate) =>
      displayPosition > candidate.displayFrom && displayPosition <= candidate.displayTo,
  )
  if (segment === undefined) {
    return null
  }
  return segment.atom
    ? segment.documentTo
    : segment.documentFrom + displayPosition - segment.displayFrom
}

function firstResultAtOrAfter(
  results: readonly SearchResult[],
  position: number,
): SearchResult | null {
  let lowerBound = 0
  let upperBound = results.length
  while (lowerBound < upperBound) {
    const midpoint = lowerBound + Math.floor((upperBound - lowerBound) / 2)
    if (results[midpoint]!.from < position) {
      lowerBound = midpoint + 1
    } else {
      upperBound = midpoint
    }
  }
  return results[lowerBound] ?? null
}

function lastResultEndingAtOrBefore(
  results: readonly SearchResult[],
  position: number,
): SearchResult | null {
  let lowerBound = 0
  let upperBound = results.length
  while (lowerBound < upperBound) {
    const midpoint = lowerBound + Math.floor((upperBound - lowerBound) / 2)
    if (results[midpoint]!.to <= position) {
      lowerBound = midpoint + 1
    } else {
      upperBound = midpoint
    }
  }
  return results[lowerBound - 1] ?? null
}

/**
 * A literal search query over Meowdown's displayed text rather than its raw
 * Markdown source. Hidden delimiters and link destinations are excluded;
 * atom views search by their visible label. Syntax configured as visible and
 * math source in `show` mode can be included without exposing atom sources.
 */
export class NoteFindQuery extends SearchQuery {
  private cachedDocument: ProseMirrorNode | null = null
  private cachedResults: readonly SearchResult[] = []
  private readonly includeSyntax: boolean

  constructor(search: string, options: NoteFindQueryOptions = {}) {
    super({ search, caseSensitive: false, literal: true })
    this.includeSyntax = options.includeSyntax === true
  }

  override findNext(
    state: EditorState,
    from = 0,
    to = state.doc.content.size,
  ): SearchResult | null {
    const result = firstResultAtOrAfter(this.results(state), from)
    return result !== null && result.to <= to ? result : null
  }

  override findPrev(
    state: EditorState,
    from = state.doc.content.size,
    to = 0,
  ): SearchResult | null {
    const result = lastResultEndingAtOrBefore(this.results(state), from)
    return result !== null && result.from >= to ? result : null
  }

  private results(state: EditorState): readonly SearchResult[] {
    if (!this.valid) {
      return []
    }
    if (this.cachedDocument === state.doc) {
      return this.cachedResults
    }

    const pattern = new RegExp(
      this.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'giu',
    )
    const results: SearchResult[] = []
    state.doc.descendants((node, position) => {
      if (!node.isTextblock) {
        return true
      }

      const contentStart = position + 1
      const projection = projectTextblock(node, contentStart, this.includeSyntax)
      for (const match of projection.text.matchAll(pattern)) {
        const matchIndex = match.index
        const matchLength = match[0].length
        const documentFrom = documentStartFor(projection.segments, matchIndex)
        const documentTo = documentEndFor(
          projection.segments,
          matchIndex + matchLength,
        )
        const previous = results.at(-1)
        if (
          documentFrom !== null &&
          documentTo !== null &&
          (previous?.from !== documentFrom || previous.to !== documentTo)
        ) {
          results.push({
            from: documentFrom,
            to: documentTo,
            match: null,
            matchStart: contentStart,
          })
        }
      }
      return false
    })

    this.cachedDocument = state.doc
    this.cachedResults = results
    return results
  }
}
