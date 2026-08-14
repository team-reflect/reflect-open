import { z } from 'zod'
import { markdownNoteReference, noteBasenameKey, wikiNoteReference } from '../graph/note-reference'
import {
  dateFromDailyPath,
  foldGraphPath,
  isCalendarDate,
  isDaily,
  isTemplatePath,
} from '../graph/paths'
import {
  detectConflictMarkers,
  extractEmailFields,
  foldEmail,
  foldKey,
  foldTag,
  gistBodyHash,
  isPinned,
  pinnedOrder,
  splitFrontmatter,
  subjectAliases,
  wikiLinkTargetForTitle,
  type ParsedNote,
} from '../markdown'
import { previewSnippet } from './snippet'
import { serializeWikiSuggestionAddress } from './suggest'

/**
 * The index write payload (Plan 04): a {@link ParsedNote} (Plan 03) flattened into
 * the row-set the Rust `index_apply` command upserts. Pure — no IO — so it's the
 * unit-testable heart of the pipeline.
 *
 * The zod schemas below are the single source of truth for the payload shape —
 * the TS types are inferred from them. They mirror the serde `IndexedNote` struct
 * in `apps/desktop/src-tauri/src/db.rs` field-for-field (camelCase ↔ serde
 * `rename_all = "camelCase"`); a change on either side must be mirrored on the
 * other, and {@link indexedNoteSchema} is the contract a drift test can assert.
 */

/**
 * Version of the projection {@link buildIndexedNote} produces. Bump it whenever
 * the rows derived from an *unchanged* file change — a new column, a changed
 * derivation — so `syncIndex` rebuilds graphs whose rows predate it. The
 * hash-based reconcile alone would never re-index an unchanged file, leaving
 * new columns at their migration defaults forever.
 *
 * History: 1 — Plan 04 baseline · 2 — `notes.preview` + `tags.tag_key` (the
 * first stamped version; v2 rows also carry the 0004 pinned columns) ·
 * 3 — repairs `notes.mtime` 0 rows written by the watcher path before it
 * carried `modifiedMs` (hash-reconcile can never refresh them) ·
 * 4 — `notes.has_conflict` (sync conflict markers, Plan 12) ·
 * 5 — `notes.gist_url` + `notes.gist_stale` (gist publishing) ·
 * 6 — rendered Markdown escapes in titles, wiki-link targets, and previews ·
 * 7 — `tasks` projection (GFM checkboxes, Plan 18): existing notes carry no task
 * rows until reprojected, so the bump backfills them ·
 * 8 — `tasks.due_date` (explicit `[[YYYY-MM-DD]]` per task, V1 Overdue semantics):
 * existing task rows have a null due date until reprojected.
 * 9 — asset descriptions folded into `search_fts.body` (Plan 20 search
 * integration): existing notes carry no asset-description text in search until
 * reprojected, so the bump rebuilds them.
 * 10 — asset reference paths fully canonicalized (`./`, `..`, empty segments
 * collapsed, not just percent-decoded): the `assets` projection's keys change,
 * so the bump rebuilds them — the privacy gate matches them against the
 * canonical on-disk path.
 * 11 — `tasks` projection limited to round Meowdown task checkboxes (`+ [ ]` /
 * `+ [x]`), excluding square checklist checkboxes from the aggregate Tasks view.
 * 12 — `notes.kind` (daily / note / template): templates are indexed but
 * excluded from note surfaces, so rows must carry the kind.
 * 13 — `note_emails` projection (`- Email:` contact-field bullets): existing
 * person notes carry no email rows until reprojected, and attendee → note
 * resolution in the calendar flow needs them, so the bump backfills them.
 * 14 — v1 subject aliases (`//` segments of the title) folded into the
 * `aliases` projection: existing v1-style titles carry no derived alias rows
 * until reprojected, so the bump backfills them.
 * 15 — task parent outline/list breadcrumbs: existing task rows carry empty
 * breadcrumbs until reprojected.
 * 16 - meowdown-aligned wiki-link parsing (the editor's own `gfmParser`) and
 * derived linkable aliases for rich titles and rich frontmatter aliases:
 * existing notes must reproject for both the recovery-semantics convergence
 * and the backfilled alias rows.
 * 17 - legacy nested `Email` / `Emails` contact fields and canonical email
 * identities: unchanged V1 person notes need their `note_emails` rows rebuilt.
 * 18 - path addressing (`notes.path_key`, `links.target_path_key`) and the
 * `note_claims` projection that replaces the tiered `note_keys` derivation:
 * existing rows carry no claims and no path keys, so vault-path links and
 * filename-stem links stay unresolved until reprojected. Name keys also gain
 * NFC folding (`foldKey`), so NFD-spelled titles need their keys rebuilt.
 * 19 - wiki `links.target_key` becomes the classifier's name key (fragment
 * and `.md` stripped; '' for strict-path, self, and refused targets), so the
 * backlinks view's name join matches navigation. Existing rows carry the raw
 * fold and must reproject.
 */
export const PROJECTION_VERSION = 19

/**
 * Precedence of the spellings a note answers to (`note_claims.tier`): the
 * lowest tier claiming a key wins it. The numbers are the storage encoding —
 * migration 0019 and the CLI read the same values.
 */
export const CLAIM_TIER = {
  /** Calendar-valid daily date (`daily/2026-07-26.md` answering to `2026-07-26`). */
  dailyDate: 1,
  /** Authored title (frontmatter or first heading; filename when untitled). */
  title: 2,
  /** Frontmatter or derived alias. */
  alias: 3,
  /** Filename stem — the weakest address, how Obsidian names every note. */
  basename: 4,
} as const

export const indexedClaimSchema = z.object({
  /** Folded spelling this note answers to. */
  key: z.string(),
  /** One of {@link CLAIM_TIER}. */
  tier: z.number().int().min(CLAIM_TIER.dailyDate).max(CLAIM_TIER.basename),
})
export type IndexedClaim = z.infer<typeof indexedClaimSchema>

export const indexedLinkSchema = z.object({
  kind: z.enum(['wiki', 'md']),
  targetRaw: z.string(),
  /**
   * Name key the link answers to: for wiki links, `wikiNoteReference`'s
   * folded key ('' when the target has no name reading, i.e. a rooted path,
   * `#self`, or a refused URI); for md links, the lowercased href.
   */
  targetKey: z.string(),
  /** Folded vault path when the link names a file; null when it names a note. */
  targetPathKey: z.string().nullable(),
  alias: z.string().nullable(),
  posFrom: z.number(),
  posTo: z.number(),
})
export type IndexedLink = z.infer<typeof indexedLinkSchema>

export const indexedTagSchema = z.object({
  /** Display casing (first-seen in the document). */
  tag: z.string(),
  /** Case-folded match key ({@link foldTag}) — what queries compare against. */
  tagKey: z.string(),
})
export type IndexedTag = z.infer<typeof indexedTagSchema>

export const indexedAliasSchema = z.object({
  alias: z.string(),
  aliasKey: z.string(),
})
export type IndexedAlias = z.infer<typeof indexedAliasSchema>

export const indexedEmailSchema = z.object({
  /** Display casing (as written in the field bullet). */
  email: z.string(),
  /** Case-folded match key ({@link foldEmail}) — what resolution compares against. */
  emailKey: z.string(),
})
export type IndexedEmail = z.infer<typeof indexedEmailSchema>

const taskBreadcrumbsSchema = z.array(z.string()).readonly()

/**
 * The `tasks.breadcrumbs` column's format: the ordered label array as one JSON
 * string. Every writer and reader of the column goes through this pair (or,
 * in Rust, `write.rs`'s `serde_json` mirror — the db tests pin that parity).
 */
export function encodeTaskBreadcrumbs(breadcrumbs: readonly string[]): string {
  return JSON.stringify(breadcrumbs)
}

export function decodeTaskBreadcrumbs(column: string): readonly string[] {
  return taskBreadcrumbsSchema.parse(JSON.parse(column))
}

export const indexedTaskSchema = z.object({
  /** Character offset of the marker's `[` in the file (UTF-16 units) — the row PK with `path`. */
  markerOffset: z.number(),
  /** Display/search text of the task's marker line, markdown stripped. */
  text: z.string(),
  /** Parent outline/list item text, top-down, displayed in the Tasks view. */
  breadcrumbs: taskBreadcrumbsSchema,
  /** The marker line verbatim — the surgical write-back's staleness guard. */
  raw: z.string(),
  checked: z.boolean(),
  /** Explicit due date (first `[[YYYY-MM-DD]]` in the item), or null — drives Overdue. */
  dueDate: z.string().nullable(),
})
export type IndexedTask = z.infer<typeof indexedTaskSchema>

/** What a `notes` row is: part of the graph (daily/note) or a template. */
export const noteKindSchema = z.enum(['daily', 'note', 'template'])
export type NoteKind = z.infer<typeof noteKindSchema>

export const indexedNoteSchema = z.object({
  path: z.string(),
  id: z.string().nullable(),
  title: z.string(),
  titleKey: z.string(),
  /** ASCII-folded graph path: what a path-qualified link joins against. */
  pathKey: z.string(),
  /** Derived from the path; templates are excluded from note surfaces. */
  kind: noteKindSchema,
  dailyDate: z.string().nullable(),
  isPrivate: z.boolean(),
  isPinned: z.boolean(),
  /** Explicit pin order (`pinned: <n>`); null for bare `pinned: true`. */
  pinnedOrder: z.number().nullable(),
  /** The file carries Git conflict markers from a sync merge (Plan 12). */
  hasConflict: z.boolean(),
  /** The published gist's html url, or null when the note has none. */
  gistUrl: z.string().nullable(),
  /** The body changed since it was last published to the gist. */
  gistStale: z.boolean(),
  fileHash: z.string(),
  mtime: z.number(),
  text: z.string(),
  /**
   * Description text of the note's referenced assets (Plan 20), folded into the
   * FTS `body` only — not the preview or the note text AI reads (chat reaches
   * descriptions solely via the read_assets tool and its live privacy gate).
   * Empty when the note has no described assets.
   */
  assetText: z.string(),
  /** The All Notes row snippet, derived once here rather than per query. */
  preview: z.string(),
  links: z.array(indexedLinkSchema),
  tags: z.array(indexedTagSchema),
  aliases: z.array(indexedAliasSchema),
  /** Every folded spelling this note answers to (see `note_claims`). */
  claims: z.array(indexedClaimSchema),
  /** Emails the note owns via `- Email:` contact-field bullets. */
  emails: z.array(indexedEmailSchema),
  assets: z.array(z.string()),
  /** Reflect task rows for the Tasks projection (Plan 18). */
  tasks: z.array(indexedTaskSchema),
})
export type IndexedNote = z.infer<typeof indexedNoteSchema>

/**
 * The `aliases` projection: `aliases:` frontmatter verbatim, then the linkable
 * form of any rich title or rich frontmatter alias ({@link wikiLinkTargetForTitle}),
 * then the v1 subject aliases derived from the title (`Charlotte MacCaw // Mum`);
 * later stages skip keys an earlier row already claims. The derived rows are
 * index-only — the file's frontmatter is never rewritten to hold them. A
 * linkable-form row is only projected when it is an address `note_keys` can
 * actually serve: distinct from its source's key and serializable as wiki-link
 * text ({@link serializeWikiSuggestionAddress}). Shared with the disk-fallback
 * resolver so index and disk derive one truth (exported as `projectNoteAliases`).
 */
export function projectNoteAliases(parsed: ParsedNote): IndexedAlias[] {
  const aliases: IndexedAlias[] = parsed.frontmatter.aliases.map((alias) => ({
    alias,
    aliasKey: foldKey(alias),
  }))
  const claimed = new Set(aliases.map((row) => row.aliasKey))
  for (const richText of [parsed.title, ...parsed.frontmatter.aliases]) {
    const linkTarget = wikiLinkTargetForTitle(richText)
    const linkTargetKey = foldKey(linkTarget)
    if (
      linkTargetKey === foldKey(richText) ||
      claimed.has(linkTargetKey) ||
      serializeWikiSuggestionAddress(linkTarget, null) === null
    ) {
      continue
    }
    claimed.add(linkTargetKey)
    aliases.push({ alias: linkTarget, aliasKey: linkTargetKey })
  }
  for (const alias of subjectAliases(parsed.title)) {
    const aliasKey = foldKey(alias)
    if (claimed.has(aliasKey)) {
      continue
    }
    claimed.add(aliasKey)
    aliases.push({ alias, aliasKey })
  }
  return aliases
}

/**
 * Every folded spelling this note answers to, with the tier that settles a
 * contest against another note. Templates claim nothing: they are reachable
 * only through an explicit `templates/…` path.
 *
 * A note with no authored title already carries its filename as its title
 * (`deriveTitle`), so the filename tier only adds an address for a note
 * whose H1 or frontmatter title differs from its filename. A key a stronger
 * tier already claims is skipped, so `claim_count` counts notes, not
 * spellings.
 */
export function projectNoteClaims(
  parsed: ParsedNote,
  aliases: readonly IndexedAlias[],
): IndexedClaim[] {
  if (isTemplatePath(parsed.path)) {
    return []
  }
  const claims: IndexedClaim[] = []
  const seen = new Set<string>()
  const claim = (key: string, tier: number): void => {
    if (key !== '' && !seen.has(key)) {
      seen.add(key)
      claims.push({ key, tier })
    }
  }
  const date = isDaily(parsed.path) ? dateFromDailyPath(parsed.path) : null
  if (date !== null && isCalendarDate(date)) {
    claim(date, CLAIM_TIER.dailyDate)
  }
  claim(foldKey(parsed.title), CLAIM_TIER.title)
  for (const alias of aliases) {
    claim(alias.aliasKey, CLAIM_TIER.alias)
  }
  claim(noteBasenameKey(parsed.path), CLAIM_TIER.basename)
  return claims
}

/**
 * Flatten a parsed note into the index payload. `meta.source` is the raw
 * markdown the note was parsed from — conflict markers are detected on it
 * (not on the extracted plain text, which may reshape marker lines).
 */
export function buildIndexedNote(
  parsed: ParsedNote,
  meta: { fileHash: string; mtime: number; source: string; assetText?: string },
): IndexedNote {
  const wikiLinks: IndexedLink[] = parsed.wikiLinks.map((link) => {
    const reference = wikiNoteReference(link.target)
    const hasNameReading = reference?.kind === 'key' || reference?.kind === 'pathOrKey'
    return {
      kind: 'wiki' as const,
      targetRaw: link.target,
      // The classifier's own name key (fragment and `.md` stripped), so the
      // backlinks view joins exactly what navigation resolves. Empty when the
      // target has no name reading (a rooted path, `#self`, a refused URI):
      // no claim is ever '', so those rows can never name-join.
      targetKey: hasNameReading ? reference.key : '',
      targetPathKey:
        reference?.kind === 'path' || reference?.kind === 'pathOrKey'
          ? foldGraphPath(reference.path)
          : null,
      alias: link.alias ?? null,
      posFrom: link.from,
      posTo: link.to,
    }
  })
  const mdLinks: IndexedLink[] = parsed.links.map((link) => {
    const reference = markdownNoteReference(parsed.path, link.href)
    return {
      kind: 'md' as const,
      targetRaw: link.href,
      targetKey: link.href.toLowerCase(),
      targetPathKey: reference?.kind === 'path' ? foldGraphPath(reference.path) : null,
      alias: null,
      posFrom: link.from,
      posTo: link.to,
    }
  })
  const aliases = projectNoteAliases(parsed)
  const body = splitFrontmatter(meta.source).body

  return {
    path: parsed.path,
    id: parsed.id ?? null,
    title: parsed.title,
    titleKey: foldKey(parsed.title),
    pathKey: foldGraphPath(parsed.path),
    kind: isDaily(parsed.path) ? 'daily' : isTemplatePath(parsed.path) ? 'template' : 'note',
    dailyDate: isDaily(parsed.path) ? dateFromDailyPath(parsed.path) : null,
    isPrivate: parsed.frontmatter.private,
    isPinned: isPinned(parsed.frontmatter),
    pinnedOrder: pinnedOrder(parsed.frontmatter),
    hasConflict: detectConflictMarkers(meta.source),
    gistUrl: parsed.frontmatter.gist?.url ?? null,
    // Staleness is a body-hash comparison (frontmatter excluded): publishing
    // writes the `gist` block itself, and a pin/private toggle is not an edit
    // worth a "republish" nudge.
    gistStale:
      parsed.frontmatter.gist !== undefined && gistBodyHash(body) !== parsed.frontmatter.gist.hash,
    fileHash: meta.fileHash,
    mtime: meta.mtime,
    text: parsed.text,
    assetText: meta.assetText ?? '',
    preview: previewSnippet(parsed.text, parsed.title),
    links: [...wikiLinks, ...mdLinks],
    tags: parsed.tags.map((tag) => ({ tag, tagKey: foldTag(tag) })),
    aliases,
    claims: projectNoteClaims(parsed, aliases),
    emails: extractEmailFields(body).map((email) => ({ email, emailKey: foldEmail(email) })),
    // One reference can contribute several candidate spellings; the
    // projection stores each path once.
    assets: [...new Set(parsed.assets.map((asset) => asset.path))],
    tasks: parsed.tasks.map((task) => ({
      markerOffset: task.markerOffset,
      text: task.text,
      breadcrumbs: task.breadcrumbs,
      raw: task.raw,
      checked: task.checked,
      dueDate: task.dueDate,
    })),
  }
}
