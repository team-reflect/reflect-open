import { z } from 'zod'
import { dateFromDailyPath, isDaily } from '../graph/paths'
import { foldKey, normalizeWikiTarget, type ParsedNote } from '../markdown'

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

/** One outbound link occurrence (wiki or markdown), with its source span. */
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

/** A frontmatter alias plus its `foldKey`-normalized match key. */
export const indexedAliasSchema = z.object({
  alias: z.string(),
  aliasKey: z.string(),
})
export type IndexedAlias = z.infer<typeof indexedAliasSchema>

/** The full per-note write payload `index_apply` upserts (keys pre-folded). */
export const indexedNoteSchema = z.object({
  path: z.string(),
  id: z.string().nullable(),
  title: z.string(),
  titleKey: z.string(),
  dailyDate: z.string().nullable(),
  isPrivate: z.boolean(),
  fileHash: z.string(),
  mtime: z.number(),
  text: z.string(),
  links: z.array(indexedLinkSchema),
  tags: z.array(z.string()),
  aliases: z.array(indexedAliasSchema),
  assets: z.array(z.string()),
})
export type IndexedNote = z.infer<typeof indexedNoteSchema>

/** Flatten a parsed note into the index payload. */
export function buildIndexedNote(
  parsed: ParsedNote,
  meta: { fileHash: string; mtime: number },
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
    fileHash: meta.fileHash,
    mtime: meta.mtime,
    text: parsed.text,
    links: [...wikiLinks, ...mdLinks],
    tags: parsed.tags,
    aliases: parsed.frontmatter.aliases.map((alias) => ({
      alias,
      aliasKey: foldKey(alias),
    })),
    assets: parsed.assets.map((asset) => asset.path),
  }
}
