import { parseNote, splitFrontmatter } from '../markdown'
import { hashContent } from '../indexing/hash'

/**
 * Sentence-aware note chunking (Plan 09). Sections split on headings, then
 * sentences accumulate toward a target size — small enough that a chunk is
 * about one idea, large enough that the embedding has context. Offsets are
 * whole-file positions (the same base the index uses for links), and each
 * chunk carries a content hash so unchanged chunks are never re-embedded.
 */

export interface NoteChunk {
  /** Nearest enclosing heading's text, if any. */
  heading: string | null
  posFrom: number
  posTo: number
  text: string
  contentHash: string
}

/** Accumulate sentences up to this size before starting a new chunk. */
const TARGET_CHARS = 1000
/** A trailing chunk smaller than this merges into its predecessor. */
const MIN_CHARS = 200

/** Sentence-ish boundaries: end punctuation + space, or a blank line. */
function sentenceSpans(text: string, base: number): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = []
  let start = 0
  const breaks = /[.!?][)"'”]?\s+|\n{2,}/g
  for (const match of text.matchAll(breaks)) {
    const end = match.index + match[0].length
    spans.push({ from: base + start, to: base + end })
    start = end
  }
  if (start < text.length) {
    spans.push({ from: base + start, to: base + text.length })
  }
  return spans
}

interface Section {
  heading: string | null
  from: number
  to: number
}

/** Chunk a note's source into embedding units. Pure; empty input → []. */
export async function chunkNote(path: string, source: string): Promise<NoteChunk[]> {
  const parsed = parseNote({ path, source })
  const headings = parsed.headings

  // Sections: the run before the first heading, then one per heading (each
  // extending to the next heading or end of file).
  const sections: Section[] = []
  const bodyStart = splitFrontmatter(source).bodyOffset
  const firstHeadingAt = headings.length > 0 ? headings[0]!.from : source.length
  if (firstHeadingAt > bodyStart) {
    sections.push({ heading: null, from: bodyStart, to: firstHeadingAt })
  }
  headings.forEach((heading, i) => {
    const to = i + 1 < headings.length ? headings[i + 1]!.from : source.length
    sections.push({ heading: heading.text, from: heading.from, to })
  })

  const chunks: NoteChunk[] = []
  for (const section of sections) {
    const text = source.slice(section.from, section.to)
    if (text.trim() === '') {
      continue
    }
    let chunkFrom = -1
    let chunkTo = -1
    const flush = async (): Promise<void> => {
      if (chunkFrom === -1) {
        return
      }
      const chunkText = source.slice(chunkFrom, chunkTo)
      if (chunkText.trim() === '') {
        chunkFrom = -1
        return
      }
      chunks.push({
        heading: section.heading,
        posFrom: chunkFrom,
        posTo: chunkTo,
        text: chunkText,
        contentHash: await hashContent(chunkText),
      })
      chunkFrom = -1
    }
    for (const span of sentenceSpans(text, section.from)) {
      if (chunkFrom === -1) {
        chunkFrom = span.from
      }
      chunkTo = span.to
      if (chunkTo - chunkFrom >= TARGET_CHARS) {
        await flush()
      }
    }
    await flush()
  }

  // A runt tail reads better (and embeds better) merged into its predecessor.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]!
    const prev = chunks[chunks.length - 2]!
    if (last.text.length < MIN_CHARS && prev.heading === last.heading) {
      const text = source.slice(prev.posFrom, last.posTo)
      chunks.splice(chunks.length - 2, 2, {
        heading: prev.heading,
        posFrom: prev.posFrom,
        posTo: last.posTo,
        text,
        contentHash: await hashContent(text),
      })
    }
  }
  return chunks
}
