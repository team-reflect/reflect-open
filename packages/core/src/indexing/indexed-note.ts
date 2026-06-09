import { dateFromDailyPath, isDaily } from '../graph/paths'
import { normalizeWikiTarget, type ParsedNote } from '../markdown'

/**
 * The index write payload (Plan 04): a {@link ParsedNote} (Plan 03) flattened into
 * the row-set the Rust `index_apply` command upserts. Pure — no IO — so it's the
 * unit-testable heart of the pipeline. Shape mirrors the Rust `IndexedNote`
 * (camelCase ↔ serde camelCase).
 */

export interface IndexedLink {
  kind: 'wiki' | 'md'
  targetRaw: string
  /** Normalized match key: case-folded wiki target, or the href for md links. */
  targetKey: string
  alias: string | null
  posFrom: number
  posTo: number
}

export interface IndexedAlias {
  alias: string
  aliasKey: string
}

export interface IndexedNote {
  path: string
  id: string | null
  title: string
  titleKey: string
  dailyDate: string | null
  isPrivate: boolean
  fileHash: string
  mtime: number
  text: string
  links: IndexedLink[]
  tags: string[]
  aliases: IndexedAlias[]
  assets: string[]
}

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
    titleKey: parsed.title.trim().toLowerCase(),
    dailyDate: isDaily(parsed.path) ? dateFromDailyPath(parsed.path) : null,
    isPrivate: parsed.frontmatter.private,
    fileHash: meta.fileHash,
    mtime: meta.mtime,
    text: parsed.text,
    links: [...wikiLinks, ...mdLinks],
    tags: parsed.tags,
    aliases: parsed.frontmatter.aliases.map((alias) => ({
      alias,
      aliasKey: alias.trim().toLowerCase(),
    })),
    assets: parsed.assets.map((asset) => asset.path),
  }
}
