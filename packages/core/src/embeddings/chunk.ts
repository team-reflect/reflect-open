import { parseNote, splitFrontmatter } from '../markdown'
import { hashContent } from '../indexing/hash'
import {
  MAX_ASSET_TEXT_CHARS,
  type AssetDescriptionBody,
} from '../indexing/asset-description-text'

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

/**
 * Accumulate one run of text into chunks: sentence spans gather toward
 * {@link TARGET_CHARS}, offsets are `base`-relative into the enclosing
 * document. No runt-tail merging here — each caller owns its own merge rule
 * (the note merges only its final chunk, asset bodies merge per body).
 */
async function chunkRun(text: string, base: number, heading: string | null): Promise<NoteChunk[]> {
  const chunks: NoteChunk[] = []
  let chunkFrom = -1
  let chunkTo = -1
  const flush = async (): Promise<void> => {
    if (chunkFrom === -1) {
      return
    }
    const chunkText = text.slice(chunkFrom - base, chunkTo - base)
    if (chunkText.trim() === '') {
      chunkFrom = -1
      return
    }
    chunks.push({
      heading,
      posFrom: chunkFrom,
      posTo: chunkTo,
      text: chunkText,
      contentHash: await hashContent(chunkText),
    })
    chunkFrom = -1
  }
  for (const span of sentenceSpans(text, base)) {
    if (chunkFrom === -1) {
      chunkFrom = span.from
    }
    chunkTo = span.to
    if (chunkTo - chunkFrom >= TARGET_CHARS) {
      await flush()
    }
  }
  await flush()
  return chunks
}

/**
 * Merge the final chunk into its predecessor when it is a runt (smaller than
 * {@link MIN_CHARS}) under the same heading — a tail that reads better (and
 * embeds better) merged. `sliceText` re-slices the merged span from the
 * source the positions index into.
 */
async function mergeRuntTail(
  chunks: NoteChunk[],
  sliceText: (from: number, to: number) => string,
): Promise<NoteChunk[]> {
  if (chunks.length < 2) {
    return chunks
  }
  const last = chunks[chunks.length - 1]!
  const prev = chunks[chunks.length - 2]!
  if (last.text.length >= MIN_CHARS || prev.heading !== last.heading) {
    return chunks
  }
  const text = sliceText(prev.posFrom, last.posTo)
  return [
    ...chunks.slice(0, -2),
    {
      heading: prev.heading,
      posFrom: prev.posFrom,
      posTo: last.posTo,
      text,
      contentHash: await hashContent(text),
    },
  ]
}

/**
 * Chunk a note's source into embedding units. Pure; empty input → [].
 * Pass `parsed` when the caller already parsed the note (the embedding
 * pipeline does, for the asset list) to avoid a second parse.
 */
export async function chunkNote(
  path: string,
  source: string,
  parsed = parseNote({ path, source }),
): Promise<NoteChunk[]> {
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
    chunks.push(...(await chunkRun(text, section.from, section.heading)))
  }

  // Only the note's final chunk merges — mid-note section tails keep their
  // historical shape, so existing chunk hashes (and the re-embed skip) hold.
  return mergeRuntTail(chunks, (from, to) => source.slice(from, to))
}

/** `assets/graphs/q4.png` → `q4.png` — the chunk heading for an asset body. */
function assetBasename(assetPath: string): string {
  return assetPath.split('/').pop() ?? assetPath
}

/**
 * Chunk a note's asset-description bodies (Plan 20 → semantic leg) into
 * embedding units attributed to the referencing note. Each body chunks like a
 * section whose heading is the asset's filename — light provenance for
 * snippets. Positions are synthetic: they start at `baseOffset` (past the end
 * of the note source, which has exclusive claim to real offsets) and advance
 * as if the bodies were appended to the note, so asset chunks order after
 * note chunks everywhere positions sort (vector pairing, related-notes
 * seeds). The combined text is capped at {@link MAX_ASSET_TEXT_CHARS},
 * mirroring the FTS fold.
 */
export async function chunkAssetDescriptions(
  bodies: readonly AssetDescriptionBody[],
  baseOffset: number,
): Promise<NoteChunk[]> {
  const chunks: NoteChunk[] = []
  let offset = baseOffset
  let budget = MAX_ASSET_TEXT_CHARS
  for (const { assetPath, body } of bodies) {
    if (chunks.length > 0) {
      budget -= 2 // the joiner counts against the FTS fold's slice — mirror it
    }
    if (budget <= 0) {
      break
    }
    const text = body.slice(0, budget)
    budget -= text.length
    const heading = assetBasename(assetPath)
    const bodyChunks = await mergeRuntTail(
      await chunkRun(text, offset, heading),
      (from, to) => text.slice(from - offset, to - offset),
    )
    chunks.push(...bodyChunks)
    offset += text.length + 2 // as if joined by the FTS fold's blank line
  }
  return chunks
}
