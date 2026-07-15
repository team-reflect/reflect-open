import { assetPrivacySnapshot } from '../../graph/commands'
import type { AssetPrivacySnapshotNote } from '../../graph/schemas'
import { hashContent } from '../../indexing/hash'
import { parseNote } from '../../markdown/extract'
import { hasUnterminatedLeadingFrontmatter } from '../../markdown/frontmatter'

/**
 * Hash the live set of note paths whose privacy is private or indeterminate.
 * Chat turns store this capability snapshot so settled model output is never
 * resent after a public note becomes private. The note bodies themselves are
 * deliberately absent from the fingerprint.
 */
export async function privacyFingerprintFromNotes(
  notes: readonly AssetPrivacySnapshotNote[],
): Promise<string> {
  const restrictedPaths = notes.flatMap((note): string[] => {
    const parsed = parseNote({ path: note.path, source: note.source })
    return hasUnterminatedLeadingFrontmatter(note.source) ||
      parsed.frontmatterWarning !== undefined ||
      parsed.frontmatter.private
      ? [note.path]
      : []
  })
  restrictedPaths.sort()
  return `privacy-v1:${await hashContent(JSON.stringify(restrictedPaths))}`
}

/** Capture and fingerprint one uncached, generation-pinned privacy snapshot. */
export async function liveChatPrivacyFingerprint(generation: number): Promise<string> {
  const snapshot = await assetPrivacySnapshot(generation)
  return privacyFingerprintFromNotes(snapshot.notes)
}
