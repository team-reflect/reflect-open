import { attachmentReferenceCandidates } from '../graph/attachment-resolution'
import { isAssetPath, isAttachmentPath } from '../graph/paths'
import type { AuthoredAttachmentReference } from '../markdown/model'

/** An index-only namespace that can never collide with a canonical `assets/…` path. */
export const ASSET_BASENAME_KEY_PREFIX = ':reflect:attachment-basename:'

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path
}

/** Index-only candidate key for a bare, ASCII-case-insensitive wiki-embed filename. */
export function assetBasenameCandidateKey(filename: string): string {
  return `${ASSET_BASENAME_KEY_PREFIX}${asciiLower(filename)}`
}

/**
 * Conservative DB keys for one authored reference. Exact rows are limited to
 * plausible supported attachments under Reflect's managed root `assets/`
 * tree. A bare wiki embed instead receives a basename sentinel so catalog
 * changes can be re-evaluated live without re-indexing its source note.
 */
export function authoredAttachmentIndexKeys(
  reference: AuthoredAttachmentReference,
): string[] {
  const candidates = attachmentReferenceCandidates({
    sourcePath: reference.sourcePath,
    reference: reference.rawReference,
    referenceKind: reference.kind,
  })
  if (candidates === null) {
    return []
  }
  if (candidates.basename !== null) {
    return [assetBasenameCandidateKey(candidates.basename)]
  }
  return candidates.exactPaths.filter(
    (path) => isAssetPath(path) && isAttachmentPath(path),
  )
}

/** Exact plus bare-wiki candidate keys whose notes must be checked for an asset. */
export function assetReferenceLookupKeys(assetPath: string): string[] {
  if (!isAssetPath(assetPath) || !isAttachmentPath(assetPath)) {
    return []
  }
  return [assetPath, assetBasenameCandidateKey(basename(assetPath))]
}

/** Deduped index projection for every attachment-shaped reference in a note. */
export function noteAttachmentIndexKeys(
  references: readonly AuthoredAttachmentReference[],
): string[] {
  const keys = new Set<string>()
  for (const reference of references) {
    for (const key of authoredAttachmentIndexKeys(reference)) {
      keys.add(key)
    }
  }
  return [...keys]
}

/**
 * Canonical managed paths whose authored syntax has exactly one possible
 * graph target without consulting the catalog. Description text and semantic
 * chunks use this conservative subset; basename sentinels, imported paths,
 * and unqualified source/root collisions never become content inputs.
 */
export function unambiguousManagedAttachmentPaths(
  references: readonly AuthoredAttachmentReference[],
): string[] {
  const paths = new Set<string>()
  for (const reference of references) {
    const candidates = attachmentReferenceCandidates({
      sourcePath: reference.sourcePath,
      reference: reference.rawReference,
      referenceKind: reference.kind,
    })
    if (
      candidates !== null &&
      candidates.basename === null &&
      candidates.exactPaths.length === 1
    ) {
      const path = candidates.exactPaths[0]!
      if (isAssetPath(path) && isAttachmentPath(path)) {
        paths.add(path)
      }
    }
  }
  return [...paths]
}
