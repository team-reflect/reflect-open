import { Document, isMap, parse as parseYaml, parseDocument } from 'yaml'
import { frontmatterSchema, type Frontmatter } from './model'

/**
 * YAML frontmatter handling (Plan 03). Markdown is the source of truth and files
 * may be edited outside Reflect, so parsing is **tolerant**: broken or non-object
 * YAML degrades to "no frontmatter" + a warning, never an unreadable note. The
 * known subset is typed via {@link frontmatterSchema}; unknown keys pass through.
 */

/** Result of carving a leading `---` block off the source. */
export interface FrontmatterSplit {
  /** YAML text between the fences, or `null` when there's no frontmatter block. */
  raw: string | null
  /** Everything after the closing fence (the markdown body). */
  body: string
  /** Character offset of `body` within the original source. */
  bodyOffset: number
}

const OPEN_FENCE = /^---[ \t]*\r?\n/
/** A closing `---` line: at the block start (empty frontmatter) or after a newline. */
const CLOSE_FENCE = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/

/** Carve a leading YAML frontmatter block off `source`, preserving offsets. */
export function splitFrontmatter(source: string): FrontmatterSplit {
  const open = OPEN_FENCE.exec(source)
  if (!open || open.index !== 0) {
    return { raw: null, body: source, bodyOffset: 0 }
  }
  const afterOpen = open[0].length
  const rest = source.slice(afterOpen)
  const close = CLOSE_FENCE.exec(rest)
  if (!close) {
    // Unterminated fence — treat the whole file as body (tolerant).
    return { raw: null, body: source, bodyOffset: 0 }
  }
  const raw = rest.slice(0, close.index)
  const bodyOffset = afterOpen + close.index + close[0].length
  return { raw, body: source.slice(bodyOffset), bodyOffset }
}

/** Parsed frontmatter plus an optional non-fatal warning. */
export interface ParsedFrontmatter {
  data: Frontmatter
  warning?: string
}

function emptyFrontmatter(): Frontmatter {
  return frontmatterSchema.parse({})
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Parse the YAML text from {@link splitFrontmatter}. Never throws: malformed or
 * non-mapping YAML yields defaults + a warning so the note stays readable.
 */
export function parseFrontmatter(raw: string | null): ParsedFrontmatter {
  if (raw === null || raw.trim() === '') {
    return { data: emptyFrontmatter() }
  }
  let loaded: unknown
  try {
    loaded = parseYaml(raw)
  } catch (err) {
    return { data: emptyFrontmatter(), warning: `invalid YAML frontmatter: ${errorMessage(err)}` }
  }
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return { data: emptyFrontmatter(), warning: 'frontmatter is not a mapping; ignored' }
  }
  // The schema is built to tolerate bad known fields (`.catch`) and preserve
  // unknown keys (`.passthrough`), so this won't throw for an object input.
  return { data: frontmatterSchema.parse(loaded) }
}

/**
 * Apply `patch` to a note's frontmatter, returning the new source. Minimal-diff:
 * the body is preserved byte-for-byte and only the frontmatter region is
 * rewritten via the YAML `Document` API, which keeps key order, comments, and
 * unknown keys. A `undefined` value deletes the key. Creates a block if none
 * exists (and the patch sets something), and removes the block entirely when
 * deleting its last key — a note whose only metadata was a toggled flag returns
 * to having no frontmatter at all, not an empty `---` husk.
 */
export function upsertFrontmatter(source: string, patch: Record<string, unknown>): string {
  // An empty patch is a no-op — never re-serialize (which could disturb comments,
  // spacing, or key order in an existing block).
  if (Object.keys(patch).length === 0) {
    return source
  }

  const { raw, body } = splitFrontmatter(source)

  if (raw === null) {
    // Deletions of keys that were never there can't create a block.
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    )
    if (Object.keys(defined).length === 0) {
      return source
    }
    const doc = new Document(defined)
    return `---\n${ensureTrailingNewline(String(doc))}---\n${source}`
  }

  const doc = parseDocument(raw)
  // Reading tolerates malformed YAML (it degrades to a warning), but *writing*
  // must not: re-serializing a partial parse would drop the bytes the parser
  // couldn't model. Refuse rather than silently corrupt the note's frontmatter.
  if (doc.errors.length > 0) {
    throw new Error(`refusing to update invalid YAML frontmatter: ${doc.errors[0]!.message}`)
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      doc.delete(key)
    } else {
      doc.set(key, value)
    }
  }
  if (isEmptyDocument(doc)) {
    return body
  }
  return `---\n${ensureTrailingNewline(String(doc))}---\n${body}`
}

/**
 * True when the patched document holds nothing worth a block: no keys and no
 * document-level comments (a commented block is kept — dropping it would lose
 * bytes the user wrote).
 */
function isEmptyDocument(doc: Document): boolean {
  const noKeys = doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0)
  return noKeys && doc.commentBefore == null && doc.comment == null
}

/** Guard against a YAML serializer that omits the trailing newline before `---`. */
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}
