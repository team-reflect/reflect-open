import {
  findWikiTargetMatchTiers,
  getIndexedFileFacts,
  type WikiTargetMatchTiers,
} from '../indexing/queries'
import {
  findExactNotePathMatches,
  findWikiTargetFallbackTiersInCatalog,
  loadWikiTargetFallbackCatalog,
  type WikiTargetFallbackCatalog,
} from '../indexing/queries-local-note-targets'
import { dbForGraphGeneration, type IndexDatabase } from '../indexing/db'
import {
  foldKey,
  foldFallbackTitleKey,
  hasAuthoredTitle,
  normalizeWikiTarget,
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

type ExistingWikiTargetOutcome =
  | { readonly kind: 'resolved'; readonly path: string; readonly fragment?: string }
  | { readonly kind: 'ambiguous'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly paths: readonly string[] }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }

/** The side-effect-free outcome of resolving one existing local note target. */
export type ExistingWikiTargetResolution = ExistingWikiTargetOutcome & {
  /** Indexed paths proven absent from the generation-pinned manifest. */
  readonly orphanedPaths?: readonly string[]
}

/**
 * A generation-pinned resolver that shares its manifest, index facts, file
 * reads, parsed candidates, and fallback catalog across multiple batches.
 */
export interface ExistingWikiTargetResolver {
  /** Resolve one batch while reusing this resolver's generation-pinned state. */
  resolve(targets: readonly string[]): Promise<ExistingWikiTargetResolution[]>
}

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
  readonly orphans: readonly string[]
}

interface LiveResolutionContext {
  readonly delta: Promise<ManifestDelta>
  readonly sources: Map<string, Promise<string>>
  readonly parsed: Map<string, Promise<ReturnType<typeof parseNote>>>
  readonly database: IndexDatabase
  readonly fallbackCatalog: () => Promise<WikiTargetFallbackCatalog>
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

function withOrphanedPaths(
  resolution: ExistingWikiTargetResolution,
  orphanedPaths: readonly string[],
): ExistingWikiTargetResolution {
  return orphanedPaths.length === 0
    ? resolution
    : { ...resolution, orphanedPaths }
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

async function manifestDelta(
  generation: number,
  database: IndexDatabase,
): Promise<ManifestDelta> {
  const [files, indexed] = await Promise.all([
    listFiles(generation),
    getIndexedFileFacts(database),
  ])
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
      return !settled ||
        facts === undefined ||
        facts.fileHash === '' ||
        facts.mtime !== file.modifiedMs
    })
    .map((file) => file.path)
  const orphans = [...indexed.keys()].filter((path) => !onDisk.has(path)).sort()
  return { candidates, placeholders, orphans }
}

function liveResolutionContext(generation: number): LiveResolutionContext {
  const database = dbForGraphGeneration(generation)
  let fallbackCatalog: Promise<WikiTargetFallbackCatalog> | undefined
  return {
    delta: manifestDelta(generation, database),
    sources: new Map(),
    parsed: new Map(),
    database,
    fallbackCatalog: () => {
      fallbackCatalog ??= loadWikiTargetFallbackCatalog(database)
      return fallbackCatalog
    },
  }
}

function readCandidate(
  context: LiveResolutionContext,
  path: string,
  generation: number,
): Promise<string> {
  const existing = context.sources.get(path)
  if (existing !== undefined) {
    return existing
  }
  const source = readNote(path, generation)
  context.sources.set(path, source)
  return source
}

function parseCandidate(
  context: LiveResolutionContext,
  path: string,
  generation: number,
): Promise<ReturnType<typeof parseNote>> {
  const existing = context.parsed.get(path)
  if (existing !== undefined) {
    return existing
  }
  const parsed = readCandidate(context, path, generation).then((source) =>
    parseNote({ path, source }),
  )
  context.parsed.set(path, parsed)
  return parsed
}

function addParsedBareMatch(
  tiers: MutableMatchTiers,
  path: string,
  parsed: ReturnType<typeof parseNote>,
  targetKey: string,
  fallbackTargetKey: string,
  targetDate: string | undefined,
): void {
  if (isTemplatePath(path)) {
    return
  }
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
  context: LiveResolutionContext,
): Promise<ExistingWikiTargetResolution> {
  const exactPathKeys = [reference.pathKey, reference.alternatePathKey].filter(
    (key): key is string => key !== null,
  )
  const bareTarget = reference.targetKey
  const indexedPromise = exactPathKeys.length > 0
    ? findExactNotePathMatches(exactPathKeys, context.database)
    : findWikiTargetMatchTiers(bareTarget, context.database)
  const [delta, indexed] = await Promise.all([context.delta, indexedPromise])
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
        await readCandidate(context, path, generation)
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
    const bareCandidates = delta.candidates.filter((path) => !isTemplatePath(path))
    const bareOrphans = delta.orphans.filter((path) => !isTemplatePath(path))
    const barePlaceholders = [...delta.placeholders].filter(
      (path) => !isTemplatePath(path),
    )
    const indexedTiers = indexed as WikiTargetMatchTiers
    const tiers = emptyTiers()
    addIndexedTiers(tiers, indexedTiers, unstable)
    const unreadable: string[] = []
    const targetDate = normalizeWikiTarget(bareTarget).date
    const fallbackTargetKey = foldFallbackTitleKey(bareTarget)
    for (const path of bareCandidates) {
      try {
        addParsedBareMatch(
          tiers,
          path,
          await parseCandidate(context, path, generation),
          bareTarget,
          fallbackTargetKey,
          targetDate,
        )
      } catch {
        unreadable.push(path)
      }
    }
    if (unreadable.length > 0 || barePlaceholders.length > 0) {
      return withOrphanedPaths(
        {
          kind: 'unavailable',
          paths: [...new Set([...unreadable, ...barePlaceholders])].sort(),
        },
        bareOrphans,
      )
    }
    for (const kind of ['date', 'title', 'alias', 'basename'] as const) {
      const resolved = outcomeForPaths(sortedPaths(tiers[kind]), delta.placeholders, reference.fragment)
      if (resolved !== null) {
        return withOrphanedPaths(resolved, bareOrphans)
      }
    }

    const indexedFallback = findWikiTargetFallbackTiersInCatalog(
      bareTarget,
      await context.fallbackCatalog(),
    )
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
        return withOrphanedPaths(resolved, bareOrphans)
      }
    }

    const unsettled = [...new Set([...bareCandidates, ...bareOrphans])].sort()
    return unsettled.length > 0
      ? withOrphanedPaths({ kind: 'unavailable', paths: unsettled }, bareOrphans)
      : { kind: 'missing' }
  }

  // Exact references are proven by the generation-pinned manifest itself;
  // unrelated stale files cannot become the requested path.
  return { kind: 'missing' }
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
  return resolveReference(reference, generation, liveResolutionContext(generation))
}

/**
 * Resolve several autocomplete targets against one generation-pinned manifest.
 * Missing/stale candidates are parsed at most once for the whole batch, so a
 * just-added duplicate can make every affected suggestion path-qualified
 * without turning each menu row into another vault walk.
 */
export async function resolveExistingWikiTargets(
  targets: readonly string[],
  generation: number,
): Promise<ExistingWikiTargetResolution[]> {
  return createExistingWikiTargetResolver(generation).resolve(targets)
}

/** Create a reusable live resolver for incremental autocomplete batches. */
export function createExistingWikiTargetResolver(
  generation: number,
): ExistingWikiTargetResolver {
  const context = liveResolutionContext(generation)
  return {
    resolve: async (targets): Promise<ExistingWikiTargetResolution[]> => {
      if (targets.length === 0) {
        return []
      }
      return Promise.all(
        targets.map((target) => {
          if (target.trim() === '') {
            return Promise.resolve<ExistingWikiTargetResolution>({ kind: 'missing' })
          }
          const reference = indexWikiNoteReference('', target)
          if (reference === null || reference.pathKey === notePathKey('')) {
            return Promise.resolve<ExistingWikiTargetResolution>({ kind: 'invalid' })
          }
          return resolveReference(reference, generation, context)
        }),
      )
    },
  }
}

/** Resolve a standard Markdown note href from its source note. */
export async function resolveExistingMarkdownTarget(
  href: string,
  sourcePath: string,
  generation: number,
): Promise<ExistingWikiTargetResolution> {
  const reference = indexMarkdownNoteReference(sourcePath, href)
  return reference === null
    ? { kind: 'invalid' }
    : resolveReference(reference, generation, liveResolutionContext(generation))
}
