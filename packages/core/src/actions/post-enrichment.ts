import type { EnrichmentContext, EnrichmentResult } from './capture-enrichment-context'
import { persistCaptureEnrichment, type PendingCaptureSnapshot } from './capture-enrichment-write'
import type { CaptureIdentity } from './capture-identity'
import { localizePostMedia } from './post-media'
import { mergePost } from './post-merge'
import { postCaptureMeta, postFrontmatterPatch } from './post-meta'
import {
  capturedPostFromFields,
  parsePostNoteBody,
  postNoteBody,
  postNoteTitle,
  type PostNoteFields,
} from './post-note'
import { fetchSyndicatedPost } from './post-syndication'
import { parsePostUrl, postPermalink } from './post-url'

/**
 * The post leg of capture enrichment (Plan 25): read the drain-written note
 * back, fetch the post from X's embed backend, merge the two, download the
 * media into the graph, and re-render the note from the merged post. No AI —
 * the deterministic `Name (@handle): text…` title beats a model's guess, and
 * the post is its own description. Every await is followed by the same
 * privacy re-check the link legs make, through the context the pass hands in.
 */

/**
 * Enrich one pending post capture. Transient failures (`network`) propagate
 * so the pass leaves the note pending for retry, exactly like the link legs.
 */
export async function enrichPostCapture(
  context: EnrichmentContext,
  identity: CaptureIdentity,
  initial: PendingCaptureSnapshot,
): Promise<EnrichmentResult> {
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
  const page = capturedPostFromFields(fields, post)

  const remote = await fetchSyndicatedPost(post.id, post.trigger)
  if (context.stale()) {
    return 'stale'
  }
  if ((await context.currentCapture(identity)) === null) {
    return 'skipped'
  }
  const merged = mergePost(page, remote.kind === 'post' ? remote.post : null)

  const localized = await localizePostMedia(context, identity, merged.media ?? [])
  if (localized.kind !== 'media') {
    return localized.kind
  }
  if (context.stale()) {
    return 'stale'
  }
  const snapshot = await context.currentCapture(identity)
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
    media: localized.media,
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
    frontmatter: { captureUrl: url, ...postFrontmatterPatch(merged) },
    generation: context.generation,
  })
  if (captureHash === null) {
    await context.skipPending(identity)
    return 'skipped'
  }
  return 'enriched'
}
