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
 * Coerce the privacy flag. `private` is a hard block (such notes must never reach
 * any external service), so coercion is explicit and predictable rather than
 * truthiness-based: a note is private only when it carries an explicit truthy
 * boolean/number/string. Anything unrecognized (typo, object, absent) is **not**
 * private — it never silently marks an unrelated note private, and the explicit
 * `private: true` path the security model relies on is always honoured. We also
 * accept the YAML 1.1-style words (`yes`/`on`) a 1.2 loader reads as strings.
 */
function coercePrivate(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1'
  }
  return false
}

/**
 * Coerce the pin value. `pinned: true` pins; a finite number pins **with an
 * explicit sidebar order** — the encoding the pinned shelf reorder writes.
 * Truthy words follow `private`'s rules; anything unrecognized is unpinned.
 */
function coercePinned(value: unknown): boolean | number {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === '1'
  }
  return false
}

/**
 * The note's published GitHub Gist (Plan 12 follow-up): written by the publish
 * action, read back to drive "Republish" and to update the same gist in place.
 * `file` is the gist filename last published as (a PATCH renames via the old
 * name), and `hash` is {@link gistBodyHash} of the published body — staleness
 * is a hash comparison, never an mtime one (writing this very block bumps the
 * file's mtime).
 */
export const gistFrontmatterSchema = z.object({
  /**
   * The gist id (`PATCH /gists/{id}` updates it in place). Coerced: ids and
   * hashes are hex and can land all-digits — our writer quotes those, but a
   * third-party frontmatter rewrite may not, and YAML would then hand us a
   * number. Coercion keeps the gist linked instead of silently forking a new
   * one on the next publish.
   */
  id: z.coerce.string(),
  /**
   * The gist's html url — what publishing copies to the clipboard.
   * Validated as https-only: only GitHub Gist URLs are valid here and
   * `openUrl()` is called directly on this value; non-http(s) schemes
   * (file://, javascript:, etc.) are rejected so a crafted frontmatter
   * cannot open arbitrary resources.
   */
  url: z.string().refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    { message: 'gist url must be an http(s) url' },
  ),
  /** The gist filename the body was last published under. */
  file: z.string(),
  /** {@link gistBodyHash} of the body as last published (coerced like `id`). */
  hash: z.coerce.string(),
})
export type GistFrontmatter = z.infer<typeof gistFrontmatterSchema>

/**
 * Known frontmatter subset; unknown keys are preserved untouched (passthrough).
 * Built to tolerate external edits — bad known fields fall back via `.catch`
 * rather than failing the whole parse and making a note unreadable.
 */
export const frontmatterSchema = z
  .looseObject({
    /** Reserved stable id. Not auto-written in the first wave (identity = path). */
    id: z.string().optional().catch(undefined),
    aliases: z.array(z.string()).catch([]).default([]),
    /** Hard privacy flag: such notes must never be sent to any external service. */
    private: z.preprocess(coercePrivate, z.boolean()).default(false),
    /**
     * Pinned to the sidebar's Pinned section: `true`, or a number for an
     * explicit order. Unpinned notes omit the key. Read through
     * {@link isPinned}/{@link pinnedOrder} — `pinned: 0` is a pinned note.
     */
    pinned: z.preprocess(coercePinned, z.union([z.boolean(), z.number()])).default(false),
    /**
     * The published GitHub Gist block. A hand-mangled block degrades to
     * "never published" (`.catch`) rather than an unreadable note; the next
     * publish then creates a fresh gist and rewrites it whole.
     */
    gist: gistFrontmatterSchema.optional().catch(undefined),
    /**
     * Contact names whose suggested-contact card was dismissed on this note
     * (v1's `ignoredContactNames`). Per contact, not per note: ignoring "Ada"
     * must not suppress a later "Grace" suggestion after a retitle. An added
     * contact needs no mark — the details it writes into the body suppress
     * the card by content. A mangled value degrades to the empty list; the
     * card reappears, nothing breaks.
     */
    ignoredContacts: z.array(z.string()).catch([]).default([]),
  })
export type Frontmatter = z.infer<typeof frontmatterSchema>

/** Is the note pinned at all? Never truthiness — `pinned: 0` is order 0, pinned. */
export function isPinned(frontmatter: Frontmatter): boolean {
  return frontmatter.pinned !== false
}

/** The explicit pin order when the key is numeric; bare `pinned: true` has none. */
export function pinnedOrder(frontmatter: Frontmatter): number | null {
  return typeof frontmatter.pinned === 'number' ? frontmatter.pinned : null
}

/** A `[[target]]` or `[[target|alias]]` reference. */
export interface WikiLink extends Span {
  /** The link target as written (pre-resolution), trimmed. */
  target: string
  /** Display alias after `|`, if present. */
  alias?: string | undefined
}

/** A standard markdown link or autolink `[text](href)`. */
export interface MarkdownLink extends Span {
  href: string
  text: string
  /** Host for external `http(s)` links, else undefined. */
  domain?: string | undefined
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

/**
 * The write-back coordinates of one task's checkbox: where its marker sits and
 * what its line looked like. Carried from the index to the toggle ({@link
 * toggleTaskMarker}); `raw` is the staleness guard that lets the toggle relocate
 * the marker — or refuse — when the file drifted under it. {@link ParsedTask}
 * extends this with the rendered text and checked state.
 */
export interface TaskMarker {
  /**
   * Character offset of the marker's `[` in the **original** file (UTF-16 code
   * units, the unit Lezer reports — never UTF-8 bytes). The toggle splices the
   * three marker characters here after re-confirming {@link raw}.
   */
  markerOffset: number
  /**
   * Exact source of the marker's physical line — the write-back staleness guard.
   * Begins with the three-character marker, so `raw.slice(0, 3)` is `[ ]`/`[x]`.
   */
  raw: string
}

/**
 * A Reflect task item (`+ [ ] text` / `+ [x] text`) — the unit the Tasks view
 * (Plan 18) projects across the graph. Square checklist checkboxes stay in the
 * note only and are intentionally excluded from the aggregate Tasks view.
 */
export interface ParsedTask extends TaskMarker {
  /** Inline text of the item's marker line, markdown stripped, for display + search. */
  text: string
  /** `[x]`/`[X]` → true, `[ ]` → false. */
  checked: boolean
  /**
   * The task's explicit due date: the first calendar-valid `[[YYYY-MM-DD]]` link
   * inside the item, or null. This is V1's "scheduling is association" mechanism —
   * a date link *in the task* is its due date, distinct from (and overriding) the
   * source note's own daily date. The Tasks view buckets Overdue strictly off this
   * (a bare task in a past daily note is Current, not Overdue — Plan 18 / V1).
   */
  dueDate: string | null
}

/** Version of the extraction contract; bump on breaking shape changes.
 * 1 — Plan 03 baseline · 2 — `tasks: ParsedTask[]` (with `dueDate`) added (Plan 18) ·
 * 3 — tasks limited to round Meowdown `+ [ ]` / `+ [x]` syntax; square checklist
 * checkboxes are excluded. */
export const PARSED_NOTE_VERSION = 3

/** The full parse of one note — the stable contract downstream plans depend on. */
export interface ParsedNote {
  /** Graph-relative path; the note's identity in the first wave. */
  path: string
  /** Stable id from frontmatter, if the note carries one (else identity = path). */
  id?: string | undefined
  /** `frontmatter.title` → first H1 → filename (or the date for daily notes). */
  title: string
  frontmatter: Frontmatter
  /** Set when YAML frontmatter failed to parse; the note is still usable. */
  frontmatterWarning?: string | undefined
  wikiLinks: WikiLink[]
  links: MarkdownLink[]
  /** Body `#tag` names (without the leading `#`), deduped, in document order. */
  tags: string[]
  headings: Heading[]
  assets: AssetRef[]
  /** Reflect task items in document order — the Tasks projection (Plan 18). */
  tasks: ParsedTask[]
  /** Plain-text rendering of the body for FTS (Plan 08) + AI context (Plan 10). */
  text: string
}
