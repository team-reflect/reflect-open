import { z } from 'zod'

/**
 * The markdown document model (Plan 03) — the canonical, parser-agnostic shape
 * the indexer (Plan 04), backlinks (Plan 07), and search/AI consume. All
 * positions are character offsets into the **original** file (frontmatter
 * included), so they map straight back for splice edits and editor decorations.
 */

/** A half-open character range `[from, to)` in the original source. */
export interface Span {
  from: number
  to: number
}

/**
 * Fail-safe coercion for the privacy flag. `private` is a hard block (such notes
 * must never reach any external service), so the risk to avoid is a false
 * *negative*. We accept the YAML 1.1-style truthy strings (`yes`/`on`/`1`) that a
 * v1.2 loader reads as plain strings, and otherwise err toward not-private only
 * for the explicit falsey/absent cases.
 */
function coercePrivate(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1'
  }
  return Boolean(value)
}

/**
 * Known frontmatter subset; unknown keys are preserved untouched (passthrough).
 * Built to tolerate external edits — bad known fields fall back via `.catch`
 * rather than failing the whole parse and making a note unreadable.
 */
export const frontmatterSchema = z
  .object({
    /** Reserved stable id. Not auto-written in the first wave (identity = path). */
    id: z.string().optional().catch(undefined),
    aliases: z.array(z.string()).catch([]).default([]),
    /** Hard privacy flag: such notes must never be sent to any external service. */
    private: z.preprocess(coercePrivate, z.boolean()).default(false),
  })
  .passthrough()
export type Frontmatter = z.infer<typeof frontmatterSchema>

/** A `[[target]]` or `[[target|alias]]` reference. */
export interface WikiLink extends Span {
  /** The link target as written (pre-resolution), trimmed. */
  target: string
  /** Display alias after `|`, if present. */
  alias?: string
}

/** A standard markdown link or autolink `[text](href)`. */
export interface MarkdownLink extends Span {
  href: string
  text: string
  /** Host for external `http(s)` links, else undefined. */
  domain?: string
}

/** An ATX or setext heading. */
export interface Heading extends Span {
  level: number
  text: string
  /** GitHub-style slug for anchors + section chunking (Plan 09). */
  slug: string
}

/** A relative reference into the graph's `assets/` directory. */
export interface AssetRef extends Span {
  /** The path as written in the link (e.g. `assets/img.png`). */
  path: string
}

/** Version of the extraction contract; bump on breaking shape changes. */
export const PARSED_NOTE_VERSION = 1

/** The full parse of one note — the stable contract downstream plans depend on. */
export interface ParsedNote {
  /** Graph-relative path; the note's identity in the first wave. */
  path: string
  /** Stable id from frontmatter, if the note carries one (else identity = path). */
  id?: string
  /** `frontmatter.title` → first H1 → filename (or the date for daily notes). */
  title: string
  frontmatter: Frontmatter
  /** Set when YAML frontmatter failed to parse; the note is still usable. */
  frontmatterWarning?: string
  wikiLinks: WikiLink[]
  links: MarkdownLink[]
  /** Body `#tag` names (without the leading `#`), deduped, in document order. */
  tags: string[]
  headings: Heading[]
  assets: AssetRef[]
  /** Plain-text rendering of the body for FTS (Plan 08) + AI context (Plan 10). */
  text: string
}
