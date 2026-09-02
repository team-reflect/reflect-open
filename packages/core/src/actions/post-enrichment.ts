import { toAppError } from '../errors'
import { captureMediaFetch, writeAsset } from '../graph/commands'
import { assetPath } from '../graph/paths'
import { persistCaptureEnrichment, type PendingCaptureSnapshot } from './capture-enrichment-write'
import type { CaptureIdentity } from './capture-identity'
import { postCaptureMeta } from './capture-note'
import { mergePost } from './post-merge'
import {
  capturedPostFromFields,
  parsePostNoteBody,
  postNoteBody,
  postNoteTitle,
  type PostNoteFields,
  type PostNoteMedia,
} from './post-note'
import { fetchSyndicatedPost } from './post-syndication'
import { parsePostUrl, postPermalink } from './post-url'

/**
 * The post leg of capture enrichment (Plan 25): fetch the post from X's
 * embed backend, merge it with what the page read, download the media into
 * the graph, and re-render the note from the merged post. No AI — the
 * deterministic `Name (@handle): text…` title beats a model's guess, and the
 * post is its own description. Every await is followed by the same privacy
 * re-check the link legs make, through the context the pass hands in.
 */

export interface PostEnrichmentContext {
  generation: number
  /** Abort gate — the graph session ended. */
  stale: () => boolean
  /** Re-read the note and its daily; marks the capture skipped and returns `null` when the gate fails. */
  currentCapture: (
    identity: CaptureIdentity,
    expectedHash?: string,
  ) => Promise<PendingCaptureSnapshot | null>
  /** Mark a still-pending capture skipped. */
  skipPending: (identity: CaptureIdentity) => Promise<void>
}

export type PostEnrichmentResult = 'enriched' | 'skipped' | 'stale'

/** Where a post's `n`th media lands: `assets/<capture base>-<n>.jpg`. */
export function postMediaAssetPath(identity: CaptureIdentity, index: number): string {
  return assetPath(`${identity.base}-${index + 1}.jpg`)
}

/**
 * Enrich one pending post capture. Transient failures (`network`) propagate
 * so the pass leaves the note pending for retry, exactly like the link legs.
 */
export async function enrichPostCapture(
  context: PostEnrichmentContext,
  identity: CaptureIdentity,
  initial: PendingCaptureSnapshot,
): Promise<PostEnrichmentResult> {
  const post = postCaptureMeta(initial.meta)
  if (post === null) {
    throw new Error('enrichPostCapture called for a link capture')
  }
  let fields: ReturnType<typeof parsePostNoteBody>
  try {
    fields = parsePostNoteBody(initial.body)
  } catch (cause) {
    // The hash check proved the body is what the drain wrote, so this is a
    // template/parser mismatch — a bug to surface, never a reason to stall
    // every capture queued behind this one.
    console.error(`post capture ${identity.base} could not be read back:`, cause)
    await context.skipPending(identity)
    return 'skipped'
  }
  const page = capturedPostFromFields(fields, { id: post.id, trigger: post.trigger })

  const remote = await fetchSyndicatedPost(post.id, post.trigger)
  if (context.stale()) {
    return 'stale'
  }
  let snapshot = await context.currentCapture(identity)
  if (snapshot === null) {
    return 'skipped'
  }
  const merged = mergePost(page, remote.kind === 'post' ? remote.post : null)

  const media: PostNoteMedia[] = []
  for (const [index, item] of (merged.media ?? []).entries()) {
    let src = item.url
    try {
      const jpeg = await captureMediaFetch(item.url)
      if (context.stale()) {
        return 'stale'
      }
      snapshot = await context.currentCapture(identity)
      if (snapshot === null) {
        return 'skipped'
      }
      const target = postMediaAssetPath(identity, index)
      await writeAsset(target, jpeg, context.generation)
      src = target
    } catch (cause) {
      if (toAppError(cause).kind === 'network') {
        throw cause
      }
      // Gone, refused, or not an image: the note keeps the remote link.
    }
    media.push({ kind: item.kind, src, alt: item.alt ?? '' })
  }
  if (context.stale()) {
    return 'stale'
  }
  snapshot = await context.currentCapture(identity)
  if (snapshot === null) {
    return 'skipped'
  }

  // A handle-less permalink (`/i/status/<id>`, the share-sheet spelling)
  // becomes the author's once the endpoint names them.
  const url =
    parsePostUrl(fields.url)?.handle === null && merged.author !== undefined
      ? postPermalink(post.id, merged.author.handle)
      : fields.url
  const enrichedFields: PostNoteFields = {
    url,
    author: merged.author ?? null,
    postedAt: merged.postedAt ?? null,
    text: merged.text ?? null,
    truncated: merged.truncated === true,
    media,
    quoted: merged.quoted ?? null,
    note: fields.note,
    screenshot: fields.screenshot,
  }
  const title = postNoteTitle(enrichedFields, snapshot.title)
  const captureHash = await persistCaptureEnrichment({
    identity,
    expectedHash: snapshot.meta.captureHash,
    body: postNoteBody(enrichedFields, title),
    fromTitle: snapshot.title,
    toTitle: title,
    status: 'done',
    provider: null,
    frontmatter: {
      captureUrl: url,
      postTruncated: merged.truncated === true ? true : undefined,
    },
    generation: context.generation,
  })
  if (captureHash === null) {
    await context.skipPending(identity)
    return 'skipped'
  }
  return 'enriched'
}
