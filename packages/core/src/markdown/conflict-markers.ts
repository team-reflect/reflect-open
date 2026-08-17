import { splitFrontmatter } from './frontmatter'
import { parseBody } from './grammar'
import { isCodeBlock } from './node-types'

/**
 * Git conflict-marker detection (Plan 12).
 *
 * A sync merge that conflicts writes standard markers into the note (labeled
 * `<<<<<<< this device` / `>>>>>>> other device` by the Rust merge) and
 * commits them — the note itself carries the conflict. The indexer calls this
 * on the raw source to project a `has_conflict` flag; when the user edits the
 * markers away, the next reindex clears it. Detection requires the full
 * `<<<<<<<` → `=======` → `>>>>>>>` sequence in order, so prose that merely
 * mentions a marker line doesn't false-positive.
 */

/** Which side of a conflict block to keep when resolving. */
export type ConflictResolution = 'ours' | 'theirs' | 'both'

/**
 * Resolve every conflict block in `source` by keeping one side (or both,
 * ours-then-theirs — the daily-note append case). Pure text splice on raw
 * lines, deliberately **never** routed through the editor: markers don't
 * survive its round-trip (verified by the Plan 12 spike), which is why
 * conflicted notes open protected and the UI resolves them through this.
 * Unterminated blocks (a truncated file) keep whatever was selected and never
 * throw. Text outside marker blocks is untouched, byte for byte.
 */
export function resolveConflictMarkers(source: string, keep: ConflictResolution): string {
  const out: string[] = []
  let section: 'text' | 'ours' | 'theirs' = 'text'
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    switch (section) {
      case 'text':
        if (line.startsWith('<<<<<<< ')) {
          section = 'ours'
        } else {
          out.push(rawLine)
        }
        break
      case 'ours':
        if (line === '=======') {
          section = 'theirs'
        } else if (keep !== 'theirs') {
          out.push(rawLine)
        }
        break
      case 'theirs':
        if (line.startsWith('>>>>>>> ')) {
          section = 'text'
        } else if (keep !== 'ours') {
          out.push(rawLine)
        }
        break
    }
  }
  return out.join('\n')
}

/**
 * The two side labels of the first complete conflict block. Git sync labels
 * sides `this device` / `other device`; the iCloud sweep (Plan 21) labels
 * them with real device names (`Alex's MacBook Pro`) or, for creation
 * collisions, the two filenames the content came from. The resolution notice
 * uses these so its buttons say what they actually keep.
 */
export interface ConflictMarkerLabels {
  /** The first side — what {@link resolveConflictMarkers} keeps for `ours`. */
  readonly ours: string
  /** The second side — kept for `theirs`. */
  readonly theirs: string
}

/**
 * Parse the side labels out of `source`'s first complete conflict block, or
 * `null` when there is none. Same in-order sequence rule as
 * {@link detectRawConflictMarkers}, so a note that "has a conflict" always has
 * labels.
 */
export function conflictMarkerLabels(source: string): ConflictMarkerLabels | null {
  let ours: string | null = null
  let sawSeparator = false
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (ours === null) {
      if (line.startsWith('<<<<<<< ')) {
        ours = line.slice('<<<<<<< '.length).trim()
      }
    } else if (!sawSeparator) {
      if (line === '=======') {
        sawSeparator = true
      }
    } else if (line.startsWith('>>>>>>> ')) {
      const theirs = line.slice('>>>>>>> '.length).trim()
      if (ours.length > 0 && theirs.length > 0) {
        return { ours, theirs }
      }
      return null
    }
  }
  return null
}

/** One side of a conflict block: its marker label and verbatim content. */
export interface ConflictSide {
  /** The device name (or colliding filename) from the marker line. */
  readonly label: string
  /** The side's raw lines, newline-joined — may be empty. */
  readonly text: string
}

/** A run of plain text, or one complete conflict block, in file order. */
export type ConflictSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'conflict'; readonly ours: ConflictSide; readonly theirs: ConflictSide }

/**
 * Split `source` into plain-text runs and complete conflict blocks, in file
 * order, so the conflict view can render each side styled instead of dumping
 * raw marker lines. Uses the same state machine as
 * {@link resolveConflictMarkers}, so a rendered side is exactly what the
 * matching resolution keeps. Every content byte lands in some segment: an
 * unterminated block (a truncated file) flows back into the surrounding text
 * verbatim, marker lines included, rather than pretending to be resolvable.
 */
export function parseConflictMarkers(source: string): ConflictSegment[] {
  const segments: ConflictSegment[] = []
  let text: string[] = []
  // The in-progress block's raw lines, so an unterminated block can rejoin
  // the text stream untouched.
  let pending: string[] = []
  let ours: string[] = []
  let theirs: string[] = []
  let oursLabel = ''
  let section: 'text' | 'ours' | 'theirs' = 'text'

  const flushText = (): void => {
    if (text.length > 0) {
      segments.push({ kind: 'text', text: text.join('\n') })
      text = []
    }
  }

  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    switch (section) {
      case 'text':
        if (line.startsWith('<<<<<<< ')) {
          section = 'ours'
          oursLabel = line.slice('<<<<<<< '.length).trim()
          pending = [rawLine]
          ours = []
          theirs = []
        } else {
          text.push(rawLine)
        }
        break
      case 'ours':
        pending.push(rawLine)
        if (line === '=======') {
          section = 'theirs'
        } else {
          ours.push(rawLine)
        }
        break
      case 'theirs':
        if (line.startsWith('>>>>>>> ')) {
          flushText()
          segments.push({
            kind: 'conflict',
            ours: { label: oursLabel, text: ours.join('\n') },
            theirs: {
              label: line.slice('>>>>>>> '.length).trim(),
              text: theirs.join('\n'),
            },
          })
          section = 'text'
          pending = []
        } else {
          pending.push(rawLine)
          theirs.push(rawLine)
        }
        break
    }
  }
  if (section !== 'text') {
    text.push(...pending)
  }
  flushText()
  return segments
}

/**
 * How many complete conflict blocks `source` carries. The iCloud sweep's
 * three-plus-way folds stack one block per extra side (Plan 21), and the
 * resolution notice pluralizes its buttons past one block — `theirs` keeps
 * every non-first side, not a single device's.
 */
export function conflictMarkerBlockCount(source: string): number {
  let count = 0
  let stage: 'start' | 'separator' | 'end' = 'start'
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    switch (stage) {
      case 'start':
        if (line.startsWith('<<<<<<< ')) {
          stage = 'separator'
        }
        break
      case 'separator':
        if (line === '=======') {
          stage = 'end'
        }
        break
      case 'end':
        if (line.startsWith('>>>>>>> ')) {
          count += 1
          stage = 'start'
        }
        break
    }
  }
  return count
}

/**
 * True when `source` contains a complete Git conflict-marker block, scanning
 * every line — code blocks included. {@link detectConflictMarkers} is the
 * code-aware check the app gates on; this raw scan is its fast pre-filter and
 * the grammar the sibling functions here share.
 */
export function detectRawConflictMarkers(source: string): boolean {
  let stage: 'start' | 'separator' | 'end' = 'start'
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    switch (stage) {
      case 'start':
        if (line.startsWith('<<<<<<< ')) {
          stage = 'separator'
        }
        break
      case 'separator':
        if (line === '=======') {
          stage = 'end'
        }
        break
      case 'end':
        if (line.startsWith('>>>>>>> ')) {
          return true
        }
        break
    }
  }
  return false
}

/** The `[from, to)` offsets of every fenced or indented code block in `body`. */
function codeBlockRanges(body: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = []
  parseBody(body).iterate({
    enter(node) {
      if (!isCodeBlock(node)) {
        return true
      }
      ranges.push([node.from, node.to])
      return false // nothing inside a code block can un-code itself
    },
  })
  return ranges
}

/**
 * True when `source` carries a complete conflict block whose marker lines sit
 * outside every code block — the only markers the editor's save pipeline would
 * rewrite and the resolution actions should act on.
 *
 * Same in-order `<<<<<<< ` / `=======` / `>>>>>>> ` rule as
 * {@link detectRawConflictMarkers}, minus any line inside a fenced or indented
 * code block. A note that *documents* a merge conflict in a code block
 * survives the editor's round trip byte for byte, so treating it as conflicted
 * would lock the author out of their own note and offer a "resolution" that
 * deletes half the example. The frontmatter header is not code: a merge can
 * drop markers into it (or a block can span the header and the body), and
 * those still count.
 */
export function detectConflictMarkers(source: string): boolean {
  // Cheap raw scan first: the scan below visits a subset of these lines and
  // the stage only ever advances, so when the full scan finds nothing the
  // subset cannot either — and the markerless common case never pays for a
  // parse.
  if (!detectRawConflictMarkers(source)) {
    return false
  }
  const { body, bodyOffset } = splitFrontmatter(source)
  const ranges = codeBlockRanges(body)
  let stage: 'start' | 'separator' | 'end' = 'start'
  let offset = 0
  for (const rawLine of source.split('\n')) {
    const startInBody = offset - bodyOffset
    offset += rawLine.length + 1
    if (startInBody >= 0 && ranges.some(([from, to]) => startInBody >= from && startInBody < to)) {
      continue
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    switch (stage) {
      case 'start':
        if (line.startsWith('<<<<<<< ')) {
          stage = 'separator'
        }
        break
      case 'separator':
        if (line === '=======') {
          stage = 'end'
        }
        break
      case 'end':
        if (line.startsWith('>>>>>>> ')) {
          return true
        }
        break
    }
  }
  return false
}
