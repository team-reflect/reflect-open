import { foldFallbackTitleKey } from '../markdown'
import { db, type IndexDatabase } from './db'

/** Every indexed note matching either exact path key, sorted and deduplicated. */
export async function findExactNotePathMatches(
  pathKeys: readonly string[],
  database: IndexDatabase = db,
): Promise<readonly string[]> {
  const keys = [...new Set(pathKeys.filter((key) => key !== ''))]
  if (keys.length === 0) {
    return []
  }
  const rows = await database
    .selectFrom('notes')
    .where('pathKey', 'in', keys)
    .select('path')
    .distinct()
    .orderBy('path')
    .execute()
  return rows.map((row) => row.path)
}

/** Leading-emoji compatibility candidates, consulted only after normal tiers miss. */
export interface WikiTargetFallbackTiers {
  readonly title: readonly string[]
  readonly alias: readonly string[]
}

/** One full fallback-key projection, reusable across a batch of targets. */
export interface WikiTargetFallbackCatalog {
  /** Fallback-folded authored title key to every owning graph-relative path. */
  readonly title: ReadonlyMap<string, readonly string[]>
  /** Fallback-folded alias key to every owning graph-relative path. */
  readonly alias: ReadonlyMap<string, readonly string[]>
}

function addFallbackOwner(
  owners: Map<string, Set<string>>,
  key: string,
  path: string,
): void {
  const paths = owners.get(key) ?? new Set<string>()
  paths.add(path)
  owners.set(key, paths)
}

function freezeFallbackOwners(
  owners: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  return new Map([...owners].map(([key, paths]) => [key, [...paths]]))
}

/**
 * Load the authored-title and alias fallback keys once. Callers resolving a
 * target batch retain this catalog so leading-emoji compatibility never turns
 * each unresolved menu row into two more full-table scans.
 */
export async function loadWikiTargetFallbackCatalog(
  database: IndexDatabase = db,
): Promise<WikiTargetFallbackCatalog> {
  const [titleRows, aliasRows] = await Promise.all([
    database
      .selectFrom('notes')
      .where('authoredTitleKey', 'is not', null)
      .where('kind', '!=', 'template')
      .select(['path', 'title'])
      .orderBy('path')
      .execute(),
    database
      .selectFrom('aliases')
      .innerJoin('notes', 'notes.path', 'aliases.notePath')
      .where('notes.kind', '!=', 'template')
      .select(['notePath', 'alias'])
      .orderBy('notePath')
      .execute(),
  ])
  const title = new Map<string, Set<string>>()
  const alias = new Map<string, Set<string>>()
  for (const row of titleRows) {
    addFallbackOwner(title, foldFallbackTitleKey(row.title), row.path)
  }
  for (const row of aliasRows) {
    addFallbackOwner(alias, foldFallbackTitleKey(row.alias), row.notePath)
  }
  return { title: freezeFallbackOwners(title), alias: freezeFallbackOwners(alias) }
}

/** Look up one target in a previously loaded fallback catalog. */
export function findWikiTargetFallbackTiersInCatalog(
  target: string,
  catalog: WikiTargetFallbackCatalog,
): WikiTargetFallbackTiers {
  const fallbackKey = foldFallbackTitleKey(target)
  return fallbackKey === ''
    ? { title: [], alias: [] }
    : {
        title: catalog.title.get(fallbackKey) ?? [],
        alias: catalog.alias.get(fallbackKey) ?? [],
      }
}

/**
 * Find indexed authored titles and aliases that become equal only after the
 * conservative leading-emoji fold. This is intentionally a last-chance
 * compatibility query: callers must exhaust date, authored title, alias, and
 * basename matches first, and must not pick an ambiguous result.
 */
export async function findWikiTargetFallbackTiers(
  target: string,
  database: IndexDatabase = db,
): Promise<WikiTargetFallbackTiers> {
  const fallbackKey = foldFallbackTitleKey(target)
  if (fallbackKey === '') {
    return { title: [], alias: [] }
  }
  return findWikiTargetFallbackTiersInCatalog(
    target,
    await loadWikiTargetFallbackCatalog(database),
  )
}
