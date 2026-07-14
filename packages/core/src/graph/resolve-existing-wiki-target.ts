import {
  findWikiTargetMatchTiers,
  getIndexedFileFacts,
  type WikiTargetMatchTiers,
} from '../indexing/queries'
import {
  findExactNotePathMatches,
  findWikiTargetFallbackTiers,
} from '../indexing/queries-local-note-targets'
import {
  foldKey,
  foldFallbackTitleKey,
  hasAuthoredTitle,
  parseNote,
  subjectAliases,
} from '../markdown'
import {
  indexMarkdownNoteReference,
  indexWikiNoteReference,
  noteBasenameKey,
  notePathKey,
  type IndexedNoteReference,
} from './local-note-reference'
import { dateFromDailyPath, isTemplatePath } from './paths'
import { listFiles, readNote } from './commands'

/** The side-effect-free outcome of resolving one existing local note target. */
export type ExistingWikiTargetResolution =
  | { readonly kind: 'resolved'; readonly path: string; readonly fragment?: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly paths: readonly string[] }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }

interface MutableMatchTiers {
  readonly date: Set<string>
  readonly title: Set<string>
  readonly alias: Set<string>
  readonly basename: Set<string>
  readonly fallbackTitle: Set<string>
  readonly fallbackAlias: Set<string>
}

interface ManifestDelta {
  readonly candidates: readonly string[]
  readonly placeholders: ReadonlySet<string>
  readonly unindexedPlaceholders: readonly string[]
  readonly orphans: readonly string[]
}

const MTIME_TRUST_AGE_MS = 5_000

function emptyTiers(): MutableMatchTiers {
  return {
    date: new Set(),
    title: new Set(),
    alias: new Set(),
    basename: new Set(),
    fallbackTitle: new Set(),
    fallbackAlias: new Set(),
  }
}

function addIndexedTiers(
  into: MutableMatchTiers,
  indexed: WikiTargetMatchTiers,
  unstable: ReadonlySet<string>,
): void {
  for (const kind of ['date', 'title', 'alias', 'basename'] as const) {
    for (const path of indexed[kind]) {
      if (!unstable.has(path)) {
        into[kind].add(path)
      }
    }
  }
}

function sortedPaths(paths: ReadonlySet<string>): string[] {
  return [...paths].sort()
}

function outcomeForPaths(
  paths: readonly string[],
  placeholders: ReadonlySet<string>,
  fragment: string | null,
): ExistingWikiTargetResolution | null {
  if (paths.length === 0) {
    return null
  }
  const unavailable = paths.filter((path) => placeholders.has(path))
  if (unavailable.length > 0) {
    return { kind: 'unavailable', paths: unavailable }
  }
  if (paths.length > 1) {
    return { kind: 'ambiguous', paths }
  }
  return fragment === null
    ? { kind: 'resolved', path: paths[0]! }
    : { kind: 'resolved', path: paths[0]!, fragment }
}

async function manifestDelta(generation: number): Promise<ManifestDelta> {
  const [files, indexed] = await Promise.all([listFiles(generation), getIndexedFileFacts()])
  const onDisk = new Set(files.map((file) => file.path))
  const placeholders = new Set(
    files.filter((file) => file.placeholder === true).map((file) => file.path),
  )
  const now = Date.now()
  const candidates = files
    .filter((file) => {
      if (file.placeholder === true) {
        return false
      }
      const facts = indexed.get(file.path)
      const settled = now - file.modifiedMs >= MTIME_TRUST_AGE_MS
      return !settled || facts === undefined || facts.mtime !== file.modifiedMs
    })
    .map((file) => file.path)
  const orphans = [...indexed.keys()].filter((path) => !onDisk.has(path)).sort()
  const unindexedPlaceholders = [...placeholders].filter((path) => !indexed.has(path)).sort()
  return { candidates, placeholders, unindexedPlaceholders, orphans }
}

function addParsedBareMatch(
  tiers: MutableMatchTiers,
  path: string,
  source: string,
  targetKey: string,
  fallbackTargetKey: string,
  targetDate: string | undefined,
): void {
  if (isTemplatePath(path)) {
    return
  }
  const parsed = parseNote({ path, source })
  if (targetDate !== undefined && dateFromDailyPath(path) === targetDate) {
    tiers.date.add(path)
  }
  if (hasAuthoredTitle(parsed) && foldKey(parsed.title) === targetKey) {
    tiers.title.add(path)
  }
  const aliases = [...parsed.frontmatter.aliases, ...subjectAliases(parsed.title)]
  if (aliases.some((alias) => foldKey(alias) === targetKey)) {
    tiers.alias.add(path)
  }
  if (noteBasenameKey(path) === targetKey) {
    tiers.basename.add(path)
  }
  if (fallbackTargetKey !== '') {
    if (hasAuthoredTitle(parsed) && foldFallbackTitleKey(parsed.title) === fallbackTargetKey) {
      tiers.fallbackTitle.add(path)
    }
    if (aliases.some((alias) => foldFallbackTitleKey(alias) === fallbackTargetKey)) {
      tiers.fallbackAlias.add(path)
    }
  }
}

async function resolveReference(
  reference: IndexedNoteReference,
  generation: number,
): Promise<ExistingWikiTargetResolution> {
  const exactPathKeys = [reference.pathKey, reference.alternatePathKey].filter(
    (key): key is string => key !== null,
  )
  const bareTarget = reference.targetKey
  const deltaPromise = manifestDelta(generation)
  const indexedPromise = exactPathKeys.length > 0
    ? findExactNotePathMatches(exactPathKeys)
    : findWikiTargetMatchTiers(bareTarget)
  const [delta, indexed] = await Promise.all([deltaPromise, indexedPromise])
  const unstable = new Set([...delta.candidates, ...delta.orphans])

  if (exactPathKeys.length > 0) {
    const desired = new Set(exactPathKeys)
    const paths = new Set(
      (indexed as readonly string[]).filter((path) => !unstable.has(path)),
    )
    const unreadable: string[] = []
    for (const path of delta.candidates) {
      if (!desired.has(notePathKey(path))) {
        continue
      }
      try {
        await readNote(path, generation)
        paths.add(path)
      } catch {
        unreadable.push(path)
      }
    }
    const placeholderMatches = [...delta.placeholders].filter((path) =>
      desired.has(notePathKey(path)),
    )
    if (unreadable.length > 0 || placeholderMatches.length > 0) {
      return { kind: 'unavailable', paths: [...new Set([...unreadable, ...placeholderMatches])].sort() }
    }
    const resolved = outcomeForPaths(sortedPaths(paths), delta.placeholders, reference.fragment)
    if (resolved !== null) {
      return resolved
    }
  } else {
    const indexedTiers = indexed as WikiTargetMatchTiers
    const tiers = emptyTiers()
    addIndexedTiers(tiers, indexedTiers, unstable)
    const unreadable: string[] = []
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(bareTarget) ? bareTarget : undefined
    const fallbackTargetKey = foldFallbackTitleKey(bareTarget)
    for (const path of delta.candidates) {
      try {
        addParsedBareMatch(
          tiers,
          path,
          await readNote(path, generation),
          bareTarget,
          fallbackTargetKey,
          targetDate,
        )
      } catch {
        unreadable.push(path)
      }
    }
    if (unreadable.length > 0 || delta.unindexedPlaceholders.length > 0) {
      return {
        kind: 'unavailable',
        paths: [...new Set([...unreadable, ...delta.unindexedPlaceholders])].sort(),
      }
    }
    for (const kind of ['date', 'title', 'alias', 'basename'] as const) {
      const resolved = outcomeForPaths(sortedPaths(tiers[kind]), delta.placeholders, reference.fragment)
      if (resolved !== null) {
        return resolved
      }
    }

    const indexedFallback = await findWikiTargetFallbackTiers(bareTarget)
    for (const path of indexedFallback.title) {
      if (!unstable.has(path)) {
        tiers.fallbackTitle.add(path)
      }
    }
    for (const path of indexedFallback.alias) {
      if (!unstable.has(path)) {
        tiers.fallbackAlias.add(path)
      }
    }
    for (const kind of ['fallbackTitle', 'fallbackAlias'] as const) {
      const resolved = outcomeForPaths(sortedPaths(tiers[kind]), delta.placeholders, reference.fragment)
      if (resolved !== null) {
        return resolved
      }
    }
  }

  // A non-empty delta means the index is still converging. Even though the
  // current candidates did not match, creating now could duplicate a note
  // whose move/edit has not settled into the projection yet.
  const unsettled = [...new Set([...delta.candidates, ...delta.orphans])].sort()
  return unsettled.length > 0 ? { kind: 'unavailable', paths: unsettled } : { kind: 'missing' }
}

/**
 * Resolve an existing wiki target against the index plus only the manifest's
 * missing/stale files. No writes occur. `sourcePath` is required only for a
 * same-note `[[#Heading]]` target; path-qualified wiki links are vault-root
 * relative by definition.
 */
export async function resolveExistingWikiTarget(
  target: string,
  generation: number,
  sourcePath = '',
): Promise<ExistingWikiTargetResolution> {
  if (target.trim() === '') {
    return { kind: 'missing' }
  }
  const reference = indexWikiNoteReference(sourcePath, target)
  if (reference === null || (reference.pathKey === notePathKey('') && sourcePath === '')) {
    return { kind: 'invalid' }
  }
  return resolveReference(reference, generation)
}

/** Resolve a standard Markdown note href from its source note. */
export async function resolveExistingMarkdownTarget(
  href: string,
  sourcePath: string,
  generation: number,
): Promise<ExistingWikiTargetResolution> {
  const reference = indexMarkdownNoteReference(sourcePath, href)
  return reference === null ? { kind: 'invalid' } : resolveReference(reference, generation)
}
