import { z } from 'zod'
import { dateFromDailyPath, isDaily } from '../graph/paths'
import {
  detectConflictMarkers,
  foldKey,
  foldTag,
  gistBodyHash,
  isPinned,
  normalizeWikiTarget,
  pinnedOrder,
  splitFrontmatter,
  type ParsedNote,
} from '../markdown'
import { previewSnippet } from './snippet'

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
 * 6 — rendered Markdown escapes in titles, wiki-link targets, and previews.
 */
export const PROJECTION_VERSION = 6

export const indexedLinkSchema = z.object({
  kind: z.enum(['wiki', 'md']),
  targetRaw: z.string(),
  /** Normalized match key: case-folded wiki target, or the lowercased href for md links. */
  targetKey: z.string(),
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

export const indexedNoteSchema = z.object({
  path: z.string(),
  id: z.string().nullable(),
  title: z.string(),
  titleKey: z.string(),
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
  /** The All Notes row snippet, derived once here rather than per query. */
  preview: z.string(),
  links: z.array(indexedLinkSchema),
  tags: z.array(indexedTagSchema),
  aliases: z.array(indexedAliasSchema),
  assets: z.array(z.string()),
})
export type IndexedNote = z.infer<typeof indexedNoteSchema>

/**
 * Flatten a parsed note into the index payload. `meta.source` is the raw
 * markdown the note was parsed from — conflict markers are detected on it
 * (not on the extracted plain text, which may reshape marker lines).
 */
export function buildIndexedNote(
  parsed: ParsedNote,
  meta: { fileHash: string; mtime: number; source: string },
): IndexedNote {
  const wikiLinks: IndexedLink[] = parsed.wikiLinks.map((link) => ({
    kind: 'wiki',
    targetRaw: link.target,
    targetKey: normalizeWikiTarget(link.target).key,
    alias: link.alias ?? null,
    posFrom: link.from,
    posTo: link.to,
  }))
  const mdLinks: IndexedLink[] = parsed.links.map((link) => ({
    kind: 'md',
    targetRaw: link.href,
    targetKey: link.href.toLowerCase(),
    alias: null,
    posFrom: link.from,
    posTo: link.to,
  }))

  return {
    path: parsed.path,
    id: parsed.id ?? null,
    title: parsed.title,
    titleKey: foldKey(parsed.title),
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
      parsed.frontmatter.gist !== undefined &&
      gistBodyHash(splitFrontmatter(meta.source).body) !== parsed.frontmatter.gist.hash,
    fileHash: meta.fileHash,
    mtime: meta.mtime,
    text: parsed.text,
    preview: previewSnippet(parsed.text, parsed.title),
    links: [...wikiLinks, ...mdLinks],
    tags: parsed.tags.map((tag) => ({ tag, tagKey: foldTag(tag) })),
    aliases: parsed.frontmatter.aliases.map((alias) => ({
      alias,
      aliasKey: foldKey(alias),
    })),
    assets: parsed.assets.map((asset) => asset.path),
  }
}
