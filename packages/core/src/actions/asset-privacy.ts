import {
  attachmentReferenceCandidates,
  prepareAttachmentCatalog,
  type AttachmentCatalogResolveOutcome,
  type AttachmentFileMeta,
  type AttachmentReference,
} from '../graph/attachment-resolution'
import { assetPrivacySnapshot } from '../graph/commands'
import { isNotePath } from '../graph/paths'
import type { AssetPrivacySnapshot, FileMeta } from '../graph/schemas'
import { parseNote } from '../markdown/extract'
import { hasUnterminatedLeadingFrontmatter } from '../markdown/frontmatter'
import { isEligibleAssetPath } from './asset-description-helpers'

/** Outcome of the privacy gate for one managed asset. */
export type AssetVerdict = 'send' | 'skip-unreferenced' | 'skip-private'

/** Live catalog resolver used by the privacy gate. */
export type AssetReferenceResolver = (
  reference: AttachmentReference,
) => AttachmentCatalogResolveOutcome

/** One live note snapshot supplied to the pure batch classifier. */
export interface AssetPrivacyNote {
  readonly path: string
  readonly source: string
}

/** Effects needed to build one fail-closed live graph snapshot. */
export interface AssetPrivacyDiscovery {
  readonly listFiles: () => Promise<FileMeta[]>
  readonly listAttachments: () => Promise<AttachmentFileMeta[]>
  readonly readNote: (path: string) => Promise<string>
}

/** Verdicts keyed by canonical managed asset path. */
export type AssetVerdicts = ReadonlyMap<string, AssetVerdict>

function requestedAssetPaths(assetPaths: readonly string[]): string[] {
  return [...new Set(assetPaths.filter(isEligibleAssetPath))]
}

function verdictsWith(paths: readonly string[], verdict: AssetVerdict): Map<string, AssetVerdict> {
  return new Map(paths.map((path) => [path, verdict]))
}

function privatePathsForOutcome(outcome: AttachmentCatalogResolveOutcome): readonly string[] {
  if (outcome.kind === 'resolved' || outcome.kind === 'unavailable') {
    return [outcome.path]
  }
  return outcome.kind === 'ambiguous' ? outcome.paths : []
}

function filesystemAliasKey(path: string): string {
  // APFS's case-insensitive lookup uses Unicode folding rather than simple
  // lowercase. Upper-then-lower conservatively catches expanding folds such
  // as ß -> SS and positional folds such as Greek final sigma.
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}

function privateAliasMatches(
  authored: AttachmentReference,
  requestedPaths: readonly string[],
): readonly string[] {
  const candidates = attachmentReferenceCandidates(authored)
  if (candidates === null) {
    return []
  }
  const exactKeys = new Set(candidates.exactPaths.map(filesystemAliasKey))
  const basenameKey =
    candidates.basename === null ? null : filesystemAliasKey(candidates.basename)
  return requestedPaths.filter((path) => {
    if (exactKeys.has(filesystemAliasKey(path))) {
      return true
    }
    const basename = path.split('/').at(-1) ?? ''
    return basenameKey !== null && filesystemAliasKey(basename) === basenameKey
  })
}

/**
 * Resolve every authored attachment reference in a live note snapshot once,
 * then derive verdicts for the whole requested managed-asset batch. Public
 * notes authorize only an exact available resolution. Private notes block an
 * exact, unavailable, or ambiguous candidate. Parsing or resolver failures
 * fail closed for every requested asset.
 */
export function classifyAssetBatchFromNotes(
  assetPaths: readonly string[],
  notes: readonly AssetPrivacyNote[],
  resolveReference: AssetReferenceResolver,
): AssetVerdicts {
  const requested = requestedAssetPaths(assetPaths)
  if (requested.length === 0) {
    return new Map()
  }
  const requestedSet = new Set(requested)
  const publicPaths = new Set<string>()
  const privatePaths = new Set<string>()

  try {
    for (const note of notes) {
      if (hasUnterminatedLeadingFrontmatter(note.source)) {
        return verdictsWith(requested, 'skip-private')
      }
      const parsed = parseNote({ path: note.path, source: note.source })
      if (parsed.frontmatterWarning !== undefined) {
        return verdictsWith(requested, 'skip-private')
      }
      for (const authored of parsed.attachmentReferences) {
        const outcome = resolveReference({
          sourcePath: authored.sourcePath,
          reference: authored.rawReference,
          referenceKind: authored.kind,
        })
        if (parsed.frontmatter.private) {
          for (const path of privateAliasMatches(
            {
              sourcePath: authored.sourcePath,
              reference: authored.rawReference,
              referenceKind: authored.kind,
            },
            requested,
          )) {
            privatePaths.add(path)
          }
          for (const path of privatePathsForOutcome(outcome)) {
            if (requestedSet.has(path)) {
              privatePaths.add(path)
            }
          }
        } else if (outcome.kind === 'resolved' && requestedSet.has(outcome.path)) {
          publicPaths.add(outcome.path)
        }
      }
    }
  } catch {
    return verdictsWith(requested, 'skip-private')
  }

  return new Map(
    requested.map((path) => [
      path,
      privatePaths.has(path)
        ? 'skip-private'
        : publicPaths.has(path)
          ? 'send'
          : 'skip-unreferenced',
    ]),
  )
}

/**
 * Discover and read every live note once, prepare one attachment catalog, and
 * classify the requested batch independently of SQLite's derived rows. Any
 * list/read failure, malformed note listing, or note placeholder blocks the
 * entire managed batch before callers inspect sidecars or source bytes.
 */
export async function classifyLiveAssetBatch(
  assetPaths: readonly string[],
  discovery: AssetPrivacyDiscovery,
): Promise<AssetVerdicts> {
  const requested = requestedAssetPaths(assetPaths)
  if (requested.length === 0) {
    return new Map()
  }
  try {
    const [noteFiles, attachments] = await Promise.all([
      discovery.listFiles(),
      discovery.listAttachments(),
    ])
    if (
      noteFiles.some(
        (file) => file.placeholder === true || !isNotePath(file.path),
      )
    ) {
      return verdictsWith(requested, 'skip-private')
    }
    const notePaths = [...new Set(noteFiles.map((file) => file.path))]
    const notes = await Promise.all(
      notePaths.map(async (path) => ({
        path,
        source: await discovery.readNote(path),
      })),
    )
    return classifyAssetBatchFromNotes(
      requested,
      notes,
      prepareAttachmentCatalog(attachments).resolve,
    )
  } catch {
    return verdictsWith(requested, 'skip-private')
  }
}

/** Classify a batch from one already-captured native privacy snapshot. */
export function classifyAssetBatchFromSnapshot(
  assetPaths: readonly string[],
  snapshot: AssetPrivacySnapshot,
): AssetVerdicts {
  const requested = requestedAssetPaths(assetPaths)
  if (
    requested.length > 0 &&
    snapshot.notes.some((note) => !isNotePath(note.path))
  ) {
    return verdictsWith(requested, 'skip-private')
  }
  return classifyAssetBatchFromNotes(
    requested,
    snapshot.notes,
    prepareAttachmentCatalog(snapshot.attachments).resolve,
  )
}

/** Generation-pinned live classification for the asset-description pass. */
export async function classifyAssetBatch(
  assetPaths: readonly string[],
  generation: number,
): Promise<AssetVerdicts> {
  const requested = requestedAssetPaths(assetPaths)
  if (requested.length === 0) {
    return new Map()
  }
  try {
    return classifyAssetBatchFromSnapshot(
      requested,
      await assetPrivacySnapshot(generation),
    )
  } catch {
    return verdictsWith(requested, 'skip-private')
  }
}

/** Convenience wrapper for callers that need one generation-pinned verdict. */
export async function classifyAsset(assetPath: string, generation: number): Promise<AssetVerdict> {
  const verdicts = await classifyAssetBatch([assetPath], generation)
  return verdicts.get(assetPath) ?? 'skip-unreferenced'
}
