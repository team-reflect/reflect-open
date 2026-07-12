import { isAppError } from '../errors'
import {
  findExactWikiTargetMatches,
  type ExactWikiTargetMatch,
} from '../indexing/queries'
import { foldFallbackTitleKey, foldKey } from '../markdown/keys'
import { parseNote } from '../markdown/extract'
import { normalizeWikiTarget } from '../markdown/resolve'
import { slugForTitle } from '../markdown/slug'
import { subjectAliases } from '../markdown/subject-aliases'
import { listFiles, readNote } from './commands'
import { dailyPath, NOTES_DIR } from './paths'

/** The side-effect-free outcome of resolving one existing wiki-link target. */
export type ExistingWikiTargetResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly paths: readonly string[] }
  | { readonly kind: 'missing' }

type ExistingMatchResolution = Exclude<ExistingWikiTargetResolution, { kind: 'missing' }>

interface DiskTitleMatch {
  readonly exactTitlePaths: readonly string[]
  readonly exactAliasPaths: readonly string[]
  readonly fallbackTitlePaths: readonly string[]
  readonly fallbackAliasPaths: readonly string[]
  readonly unavailablePaths: readonly string[]
}

type ListNoteFiles = () => ReturnType<typeof listFiles>

function resolutionForPaths(paths: readonly string[]): ExistingMatchResolution | null {
  if (paths.length === 1) {
    return { kind: 'resolved', path: paths[0]! }
  }
  if (paths.length > 1) {
    return { kind: 'ambiguous', paths: [...paths].sort() }
  }
  return null
}

/** Does `path` belong to `slug.md`, `slug-2.md`, ... under `notes/`? */
function isSlugFamilyPath(path: string, slug: string): boolean {
  const prefix = `${NOTES_DIR}/`
  const suffix = '.md'
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return false
  }
  const stem = path.slice(prefix.length, -suffix.length)
  if (stem === slug) {
    return true
  }
  if (!stem.startsWith(`${slug}-`)) {
    return false
  }
  return /^\d+$/.test(stem.slice(slug.length + 1))
}

/**
 * Inspect only the target's title-derived filename family. This deliberately
 * is not a graph-wide alias scan: link resolution must remain bounded even
 * when the index is rebuilding.
 */
async function matchTitleOnDisk(
  title: string,
  generation: number,
  listNoteFiles: ListNoteFiles,
): Promise<DiskTitleMatch> {
  const slug = slugForTitle(title)
  const candidates = (await listNoteFiles())
    .filter((file) => isSlugFamilyPath(file.path, slug))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const targetKey = foldKey(title)
  const fallbackKey = foldFallbackTitleKey(title)
  const exactTitlePaths: string[] = []
  const exactAliasPaths: string[] = []
  const fallbackTitlePaths: string[] = []
  const fallbackAliasPaths: string[] = []
  const unavailablePaths: string[] = []

  for (const candidate of candidates) {
    if (candidate.placeholder === true) {
      unavailablePaths.push(candidate.path)
      continue
    }
    let source: string
    try {
      source = await readNote(candidate.path, generation)
    } catch {
      // A candidate that vanishes after listing is not proven absent: sync
      // may restore it before an atomic claim. Preserve the creation guard.
      unavailablePaths.push(candidate.path)
      continue
    }
    const parsed = parseNote({ path: candidate.path, source })
    const aliases = [...parsed.frontmatter.aliases, ...subjectAliases(parsed.title)]
    if (foldKey(parsed.title) === targetKey) {
      exactTitlePaths.push(candidate.path)
      continue
    }
    if (aliases.some((alias) => foldKey(alias) === targetKey)) {
      exactAliasPaths.push(candidate.path)
      continue
    }
    if (fallbackKey !== '' && foldFallbackTitleKey(parsed.title) === fallbackKey) {
      fallbackTitlePaths.push(candidate.path)
      continue
    }
    if (
      fallbackKey !== '' &&
      aliases.some((alias) => foldFallbackTitleKey(alias) === fallbackKey)
    ) {
      fallbackAliasPaths.push(candidate.path)
    }
  }

  return {
    exactTitlePaths,
    exactAliasPaths,
    fallbackTitlePaths,
    fallbackAliasPaths,
    unavailablePaths,
  }
}

function diskTitleResolution(disk: DiskTitleMatch): ExistingMatchResolution | null {
  // An unavailable family member might claim any precedence tier, so no
  // readable sibling is safe to choose until every candidate can be read.
  if (disk.unavailablePaths.length > 0) {
    return { kind: 'unavailable', paths: [...disk.unavailablePaths].sort() }
  }

  for (const paths of [
    disk.exactTitlePaths,
    disk.exactAliasPaths,
    disk.fallbackTitlePaths,
    disk.fallbackAliasPaths,
  ]) {
    const resolution = resolutionForPaths(paths)
    if (resolution !== null) {
      return resolution
    }
  }
  return null
}

async function dailyFileResolution(
  date: string,
  generation: number,
  listNoteFiles: ListNoteFiles,
): Promise<ExistingMatchResolution | null> {
  const path = dailyPath(date)
  try {
    await readNote(path, generation)
    return { kind: 'resolved', path }
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      // An iCloud-evicted daily exists only as `.date.md.icloud`, so reading
      // its logical path reports notFound. The generation-pinned listing maps
      // that stub back to `path` with `placeholder: true`; it is unavailable,
      // not permission to enter the lazy-create path.
      const listed = (await listNoteFiles()).some((file) => file.path === path)
      return listed ? { kind: 'unavailable', paths: [path] } : null
    }
    return { kind: 'unavailable', paths: [path] }
  }
}

/**
 * Apply index precedence while letting an index-lagging daily file outrank an
 * indexed regular title or alias with the same ISO date spelling.
 */
async function indexedResolution(
  match: ExactWikiTargetMatch,
  date: string | undefined,
  generation: number,
  listNoteFiles: ListNoteFiles,
): Promise<ExistingMatchResolution | null> {
  if (match.kind === 'date') {
    return resolutionForPaths(match.paths)
  }
  if (date !== undefined) {
    const daily = await dailyFileResolution(date, generation, listNoteFiles)
    if (daily !== null) {
      return daily
    }
  }
  return match.kind === 'missing' ? null : resolutionForPaths(match.paths)
}

/**
 * Resolve an existing wiki target without creating or modifying anything.
 *
 * The index supplies date/title/alias precedence and preserves ambiguity. A
 * generation-pinned disk probe fills two intentional index-lag gaps: a daily
 * file is checked before a lower indexed tier, and an index miss scans only
 * the regular note's slug family. A final index lookup closes the common race
 * where indexing completes during the disk scan. An alias stored outside its
 * title's slug family therefore remains missing until the index sees it.
 */
export async function resolveExistingWikiTarget(
  target: string,
  generation: number,
): Promise<ExistingWikiTargetResolution> {
  const normalized = normalizeWikiTarget(target)
  if (normalized.key === '') {
    return { kind: 'missing' }
  }
  let listedFiles: ReturnType<typeof listFiles> | null = null
  function listNoteFiles(): ReturnType<typeof listFiles> {
    listedFiles ??= listFiles(generation)
    return listedFiles
  }

  const indexed = await indexedResolution(
    await findExactWikiTargetMatches(normalized.raw),
    normalized.date,
    generation,
    listNoteFiles,
  )
  if (indexed !== null) {
    return indexed
  }

  const disk = diskTitleResolution(
    await matchTitleOnDisk(normalized.raw, generation, listNoteFiles),
  )
  if (disk !== null) {
    return disk
  }

  const reResolved = await indexedResolution(
    await findExactWikiTargetMatches(normalized.raw),
    normalized.date,
    generation,
    listNoteFiles,
  )
  return reResolved ?? { kind: 'missing' }
}
