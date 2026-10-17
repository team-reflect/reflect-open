import type { MaybePromise } from '@reflect/utils'
import { isAppError } from '../errors.ts'
import { CLAIM_TIER, projectNoteAliases } from '../indexing/indexed-note.ts'
import type { WikiResolverService, WikiTargetMatch } from '../indexing/wiki-resolver-service.ts'
import { parseNote } from '../markdown/extract.ts'
import { foldFallbackTitleKey, foldKey } from '../markdown/keys.ts'
import { normalizeWikiTarget } from '../markdown/resolve.ts'
import { slugForTitle } from '../markdown/slug.ts'
import type { NoteFileService } from './note-file-service.ts'
import { markdownNoteReference, wikiNoteReference, type NoteReference } from './note-reference.ts'
import { dailyPath, foldGraphPath, NOTES_DIR } from './paths.ts'
import type { FileMeta } from './schemas.ts'

/**
 * The side-effect-free outcome of resolving one existing note-link target.
 */
export type ExistingWikiTargetResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly paths: readonly string[] }
  | { readonly kind: 'missing' }

/**
 * Decides which existing note a `[[wiki link]]` or Markdown href points at,
 * without creating or modifying anything.
 */
export interface NoteLinkResolverService {
  /**
   * Resolve a wiki target. A bare name runs the index tiers (daily date,
   * title, alias, filename stem), the daily file probe, the bounded
   * slug-family disk scan, then the index again. `sourcePath` matters only
   * for a bare `[[#Heading]]`, which stays inside its own note; a
   * path-qualified wiki target is vault-root relative.
   */
  resolveWikiTarget(
    target: string,
    generation: number,
    sourcePath?: string,
  ): MaybePromise<ExistingWikiTargetResolution>
  /**
   * Resolve a standard Markdown note href from the note that contains it.
   */
  resolveMarkdownHref(
    sourcePath: string,
    href: string,
    generation: number,
  ): MaybePromise<ExistingWikiTargetResolution>
}

type ExistingMatchResolution = Exclude<ExistingWikiTargetResolution, { kind: 'missing' }>

interface DiskTitleMatch {
  readonly exactTitlePaths: readonly string[]
  readonly exactAliasPaths: readonly string[]
  readonly fallbackTitlePaths: readonly string[]
  readonly fallbackAliasPaths: readonly string[]
  readonly unavailablePaths: readonly string[]
}

type ListNoteFiles = () => Promise<FileMeta[]>

function resolutionForPaths(paths: readonly string[]): ExistingMatchResolution | null {
  if (paths.length === 1) {
    return { kind: 'resolved', path: paths[0]! }
  }
  if (paths.length > 1) {
    return { kind: 'ambiguous', paths: [...paths].sort() }
  }
  return null
}

/**
 * Does `path` belong to `slug.md`, `slug-2.md`, ... under `notes/`?
 */
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

export interface NoteLinkResolverServiceDeps {
  readonly wikiResolver: WikiResolverService
  readonly noteFile: NoteFileService
}

class NoteLinkResolverServiceImpl implements NoteLinkResolverService {
  readonly #deps: NoteLinkResolverServiceDeps

  constructor(deps: NoteLinkResolverServiceDeps) {
    this.#deps = deps
  }

  async resolveWikiTarget(
    target: string,
    generation: number,
    sourcePath = '',
  ): Promise<ExistingWikiTargetResolution> {
    const reference = wikiNoteReference(target)
    return reference === null
      ? { kind: 'missing' }
      : await this.#resolveReference(reference, sourcePath, generation)
  }

  async resolveMarkdownHref(
    sourcePath: string,
    href: string,
    generation: number,
  ): Promise<ExistingWikiTargetResolution> {
    const reference = markdownNoteReference(sourcePath, href)
    return reference === null
      ? { kind: 'missing' }
      : await this.#resolveReference(reference, sourcePath, generation)
  }

  /**
   * Inspect only the target's title-derived filename family. This deliberately
   * is not a graph-wide alias scan: link resolution must remain bounded even
   * when the index is rebuilding.
   */
  async #matchTitleOnDisk(
    title: string,
    generation: number,
    listNoteFiles: ListNoteFiles,
  ): Promise<DiskTitleMatch> {
    const { noteFile } = this.#deps
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
        source = await noteFile.read(candidate.path, generation)
      } catch {
        // A candidate that vanishes after listing is not proven absent: sync
        // may restore it before an atomic claim. Preserve the creation guard.
        unavailablePaths.push(candidate.path)
        continue
      }
      const parsed = parseNote({ path: candidate.path, source })
      // Same alias derivation the index projection uses (frontmatter, linkable
      // rich-title form, subject aliases), so disk fallback and index agree.
      const aliases = projectNoteAliases(parsed).map((row) => row.alias)
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

  async #dailyFileResolution(
    date: string,
    generation: number,
    listNoteFiles: ListNoteFiles,
  ): Promise<ExistingMatchResolution | null> {
    const { noteFile } = this.#deps
    const path = dailyPath(date)
    try {
      await noteFile.read(path, generation)
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
  async #indexedResolution(
    match: WikiTargetMatch,
    date: string | undefined,
    generation: number,
    listNoteFiles: ListNoteFiles,
  ): Promise<ExistingMatchResolution | null> {
    if (match.tier === CLAIM_TIER.dailyDate) {
      return resolutionForPaths(match.paths)
    }
    if (date !== undefined) {
      const daily = await this.#dailyFileResolution(date, generation, listNoteFiles)
      if (daily !== null) {
        return daily
      }
    }
    // An unclaimed key has no paths, which resolves to null on its own.
    return resolutionForPaths(match.paths)
  }

  /**
   * The bare-name pipeline: index tiers (daily date, title, alias, filename
   * stem via `note_claims`), the daily file probe, the bounded slug-family disk
   * scan, then the index again to close the race where indexing completes
   * during the disk scan. An alias stored outside its title's slug family
   * therefore remains missing until the index sees it.
   */
  async #resolveBareKey(key: string, generation: number): Promise<ExistingWikiTargetResolution> {
    const { wikiResolver, noteFile } = this.#deps
    const normalized = normalizeWikiTarget(key)
    if (normalized.key === '') {
      return { kind: 'missing' }
    }
    let listedFiles: Promise<FileMeta[]> | null = null
    function listNoteFiles(): Promise<FileMeta[]> {
      listedFiles ??= noteFile.listNotes(generation)
      return listedFiles
    }

    const indexed = await this.#indexedResolution(
      await wikiResolver.findWikiTargetMatch(normalized.key),
      normalized.date,
      generation,
      listNoteFiles,
    )
    if (indexed !== null) {
      return indexed
    }

    const disk = diskTitleResolution(
      await this.#matchTitleOnDisk(normalized.raw, generation, listNoteFiles),
    )
    if (disk !== null) {
      return disk
    }

    const reResolved = await this.#indexedResolution(
      await wikiResolver.findWikiTargetMatch(normalized.key),
      normalized.date,
      generation,
      listNoteFiles,
    )
    return reResolved ?? { kind: 'missing' }
  }

  /**
   * A path names one file, so the index needs no ranking and the disk probe is
   * exactly one read. This is why path links need none of the bounded
   * slug-family scan a bare name needs.
   */
  async #pathResolution(path: string, generation: number): Promise<ExistingMatchResolution | null> {
    const { wikiResolver, noteFile } = this.#deps
    const indexed = await wikiResolver.findNotesByPathKey(foldGraphPath(path))
    const resolution = resolutionForPaths(indexed)
    if (resolution !== null) {
      return resolution
    }
    try {
      await noteFile.read(path, generation)
      return { kind: 'resolved', path }
    } catch (cause) {
      // Absent is a real answer for a *rooted* path link: `[[/Plan]]` to a file
      // that does not exist is a broken link, never an invitation to open a
      // same-named file elsewhere. A non-rooted slashed target reaches this via
      // `pathOrKey` and falls back to name resolution instead.
      return isAppError(cause) && cause.kind === 'notFound'
        ? null
        : { kind: 'unavailable', paths: [path] }
    }
  }

  async #resolveReference(
    reference: NoteReference,
    sourcePath: string,
    generation: number,
  ): Promise<ExistingWikiTargetResolution> {
    if (reference.kind === 'self') {
      // Reopening the current note is a no-op. Reporting `missing` here would
      // send the writable resolver off to create a note named `#Heading`.
      return sourcePath === '' ? { kind: 'missing' } : { kind: 'resolved', path: sourcePath }
    }
    if (reference.kind === 'path') {
      return (await this.#pathResolution(reference.path, generation)) ?? { kind: 'missing' }
    }
    if (reference.kind === 'pathOrKey') {
      // The path reading is more specific, so an existing (or unavailable) file
      // wins; a target that names no file falls back to the name it also
      // spells. Only an explicit leading `/` opts out of this fallback.
      const asPath = await this.#pathResolution(reference.path, generation)
      if (asPath !== null) {
        return asPath
      }
      return await this.#resolveBareKey(reference.key, generation)
    }
    return await this.#resolveBareKey(reference.key, generation)
  }
}

export function createNoteLinkResolverService(
  deps: NoteLinkResolverServiceDeps,
): NoteLinkResolverService {
  return new NoteLinkResolverServiceImpl(deps)
}
