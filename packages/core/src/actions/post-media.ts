import { toAppError } from '../errors'
import { captureMediaFetch, writeAsset } from '../graph/commands'
import type { PostMedia } from './capture-envelope'
import { postMediaAssetPath, type CaptureIdentity } from './capture-identity'
import type { EnrichmentContext } from './capture-enrichment-context'
import type { PostNoteMedia } from './post-note'

/** How localization ended: the note lines to write, or why the leg must stop. */
export type LocalizedMedia =
  | { kind: 'media'; media: PostNoteMedia[] }
  | { kind: 'stale' }
  | { kind: 'skipped' }

/**
 * Download a post's images into the graph (`assets/<base>-<n>.jpg`), one
 * at a time, re-checking the privacy gate before every asset write. A
 * permanent failure (gone, refused, not an image) keeps that item's remote
 * link; a transient one (`network`) propagates so the whole capture retries
 * on the next pass.
 */
export async function localizePostMedia(
  context: EnrichmentContext,
  identity: CaptureIdentity,
  media: readonly PostMedia[],
): Promise<LocalizedMedia> {
  const localized: PostNoteMedia[] = []
  for (const [index, item] of media.entries()) {
    let src = item.url
    try {
      const jpeg = await captureMediaFetch(item.url)
      if (context.stale()) {
        return { kind: 'stale' }
      }
      if ((await context.currentCapture(identity)) === null) {
        return { kind: 'skipped' }
      }
      const target = postMediaAssetPath(identity, index)
      await writeAsset(target, jpeg, context.generation)
      src = target
    } catch (cause) {
      if (toAppError(cause).kind === 'network') {
        throw cause
      }
    }
    localized.push({ kind: item.kind, src, alt: item.alt ?? '' })
  }
  return { kind: 'media', media: localized }
}
