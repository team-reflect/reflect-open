import { isAppError, ReflectError } from '../errors'
import { captureMediaFetch, writeAsset } from '../graph/commands'
import { assetPath } from '../graph/paths'
import type { XPost } from './capture-envelope'
import { persistCaptureEnrichment, type PendingCaptureSnapshot } from './capture-enrichment-write'
import type { CaptureIdentity } from './capture-identity'
import { xCaptureInputSchema } from './x-capture'
import { xPostId } from './x-post'
import { renderXPostNote, xPostTitle } from './x-post-note'
import { fetchSyndicatedXPost } from './x-syndication'

function chooseText(page: XPost['text'], remote: XPost['text']): XPost['text'] {
  if (!remote) return page
  if (!page) return remote
  if (page.complete !== remote.complete) return page.complete ? page : remote
  return page.value.length >= remote.value.length ? page : remote
}

function mergePost(page: XPost, remote: XPost | null): XPost {
  if (!remote || page.id !== remote.id) return page
  const images = [
    ...new Map(
      [...(page.images ?? []), ...(remote.images ?? [])].map((image) => [
        new URL(image.url).href,
        image,
      ]),
    ).values(),
  ].slice(0, 4)
  const quote =
    page.quote && remote.quote && page.quote.id === remote.quote.id
      ? {
          ...page.quote,
          author: page.quote.author ?? remote.quote.author,
          text: chooseText(page.quote.text, remote.quote.text),
        }
      : (page.quote ?? remote.quote)
  return {
    ...page,
    author: page.author ?? remote.author,
    text: chooseText(page.text, remote.text),
    images,
    quote,
  }
}

async function optionalImage(url: string): Promise<string | null> {
  try {
    return await captureMediaFetch(url)
  } catch (cause) {
    if (isAppError(cause) && (cause.kind === 'notFound' || cause.kind === 'parse')) return null
    throw cause
  }
}

interface EnrichXCaptureInput {
  identity: CaptureIdentity
  generation: number
  snapshot: PendingCaptureSnapshot
  current: () => Promise<PendingCaptureSnapshot | null>
  canWrite: () => boolean
}

/** Enrich from durable input and commit one final body. */
export async function enrichXCapture(input: EnrichXCaptureInput): Promise<boolean> {
  const { identity, generation, snapshot, current, canWrite } = input
  const parsed = xCaptureInputSchema.safeParse(snapshot.meta.captureInput)
  const captureId = snapshot.meta.captureId
  if (!parsed.success || !captureId || xPostId(snapshot.meta.captureUrl) !== parsed.data.post.id) {
    throw new ReflectError('parse', `Invalid X capture input in ${identity.notePath}`)
  }
  if (!(await current())) return false
  const remote = await fetchSyndicatedXPost(parsed.data.post.id)
  if (!(await current())) return false
  const captured = { ...parsed.data, post: mergePost(parsed.data.post, remote) }
  const localImages = new Map<string, string>()
  for (const [index, image] of (captured.post.images ?? []).entries()) {
    if (!(await current())) return false
    const bytes = await optionalImage(image.url)
    if (!(await current())) return false
    if (bytes !== null) {
      const path = assetPath(`capture-${captureId.toLowerCase()}-${index + 1}.jpg`)
      await writeAsset(path, bytes, generation)
      if (!(await current())) return false
      localImages.set(image.url, path)
    }
  }
  if (!(await current())) return false
  const captureHash = await persistCaptureEnrichment({
    identity,
    generation,
    expectedHash: snapshot.meta.captureHash,
    expectedInput: snapshot.meta.captureInput,
    expectedCaptureId: captureId,
    body: renderXPostNote(captured, localImages),
    fromTitle: snapshot.title,
    toTitle: xPostTitle(captured.post),
    status: 'done',
    provider: null,
    canWrite,
  })
  return captureHash !== null
}
