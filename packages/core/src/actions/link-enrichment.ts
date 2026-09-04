import {
  describePage,
  isDescriptionRejected,
  normalizedPageTitle,
  type PageEnrichment,
} from '../ai/describe-page'
import { isAppError, toAppError } from '../errors'
import { captureLinkPreview, readAsset, writeAsset } from '../graph/commands'
import type { PageMeta } from '../link-preview/metadata'
import type { AiProviderConfig } from '../settings/schema'
import type { EnrichmentContext, EnrichmentResult } from './capture-enrichment-context'
import { persistCaptureEnrichment, type PendingCaptureSnapshot } from './capture-enrichment-write'
import type { CaptureIdentity } from './capture-identity'
import {
  captureDescriptionFromBody,
  capturePageTextFromBody,
  displayTitle,
  hasDescription,
  metadataValue,
  withDescription,
  withScreenshot,
  withTitle,
  type CaptureNoteMeta,
} from './capture-note'
import { scrapePageMeta } from './meta-scrape'

/**
 * The link legs of capture enrichment (Plan 11): scrape the page's meta tags
 * and display title, attach a platform link preview when the capture has no
 * screenshot, persist that checkpoint, then make the optional BYOK AI call
 * for a title and description. The metadata checkpoint lands before the AI
 * call so a provider failure never hides the scrape; the two-file retitle
 * goes through `persistCaptureEnrichment`'s transaction.
 */

export interface LinkEnrichmentContext extends EnrichmentContext {
  /** The configured default provider, or `null` for metadata-only enrichment. */
  config: AiProviderConfig | null
  /** The provider's key, or `null` while it is unavailable. */
  apiKey: string | null
  /** Transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch | undefined
}

interface GenerateEnrichmentInput {
  config: AiProviderConfig
  apiKey: string
  fetchFn?: typeof fetch | undefined
  /** The pending capture's frontmatter keys (URL, screenshot asset). */
  meta: CaptureNoteMeta
  /** The note's current display title. */
  title: string
  scraped: PageMeta | null
  /** The raw drain-written body (page text is extracted from it). */
  body: string
  screenshotBase64?: string | undefined
}

/**
 * The AI leg of one capture's enrichment: make the one-shot provider call and
 * treat a provider refusal as "no enrichment" (`null`) — the scraped meta is
 * the fallback. Transient failures (`auth`, `network`) propagate for retry.
 */
async function generateEnrichment(input: GenerateEnrichmentInput): Promise<PageEnrichment | null> {
  try {
    return await describePage({
      config: input.config,
      apiKey: input.apiKey,
      fetchFn: input.fetchFn,
      url: input.meta.captureUrl,
      title: input.title,
      metaTitle: input.scraped?.title ?? undefined,
      siteName: input.scraped?.siteName ?? undefined,
      metaDescription: input.scraped?.description ?? undefined,
      contentText: capturePageTextFromBody(input.body),
      screenshotBase64: input.screenshotBase64,
    })
  } catch (cause) {
    if (!isDescriptionRejected(cause)) {
      throw cause
    }
    return null
  }
}

async function readCaptureScreenshot(
  meta: CaptureNoteMeta,
  generation: number,
): Promise<string | undefined> {
  if (!meta.captureScreenshot) {
    return undefined
  }
  try {
    return await readAsset(meta.captureScreenshot, generation)
  } catch (cause) {
    if (!isAppError(cause) || cause.kind !== 'notFound') {
      throw cause
    }
    return undefined
  }
}

async function fetchLinkPreviewImage(meta: CaptureNoteMeta): Promise<string | null> {
  if (meta.captureScreenshot) {
    return null
  }
  try {
    return await captureLinkPreview(meta.captureUrl)
  } catch {
    return null
  }
}

/**
 * The page meta for a capture: the checkpointed note's own title and
 * description on a resume, else a fresh scrape. Permanent scrape failures
 * (invalid URL, non-HTML, non-retryable status) read as no metadata;
 * transient ones (`network`, `auth`) propagate for retry.
 */
async function pageMetaFor(
  snapshot: PendingCaptureSnapshot,
  metadataComplete: boolean,
): Promise<PageMeta | null> {
  if (metadataComplete) {
    // Deliberately lossy resume: the checkpoint keeps only what the note
    // shows, so a retried AI call sees the current H1 as the meta title
    // and loses `siteName` — close enough that persisting the raw scrape
    // isn't worth another frontmatter field.
    return {
      title: snapshot.title,
      description: captureDescriptionFromBody(snapshot.body) ?? null,
      siteName: null,
    }
  }
  try {
    return await scrapePageMeta(snapshot.meta.captureUrl)
  } catch (cause) {
    const kind = toAppError(cause).kind
    if (kind === 'network' || kind === 'auth') {
      throw cause
    }
    return null
  }
}

/**
 * Enrich one pending link capture. Transient failures (`network`, `auth`)
 * propagate so the pass decides whether to retry or abort.
 */
export async function enrichLinkCapture(
  context: LinkEnrichmentContext,
  identity: CaptureIdentity,
  initial: PendingCaptureSnapshot,
): Promise<EnrichmentResult> {
  const { config, apiKey } = context
  let snapshot = initial
  const metadataComplete = snapshot.meta.captureMetadataStatus === 'done'
  if (metadataComplete && apiKey === null) {
    if (config !== null) {
      return 'waiting-for-key'
    }
    const captureHash = await persistCaptureEnrichment({
      identity,
      expectedHash: snapshot.meta.captureHash,
      body: snapshot.body,
      fromTitle: snapshot.title,
      toTitle: snapshot.title,
      status: 'done',
      provider: null,
      generation: context.generation,
    })
    if (captureHash === null) {
      await context.skipPending(identity)
      return 'skipped'
    }
    return 'enriched'
  }

  const pageMeta = await pageMetaFor(snapshot, metadataComplete)
  if (context.stale()) {
    return 'stale'
  }
  let current = await context.currentCapture(identity)
  if (current === null) {
    return 'skipped'
  }
  snapshot = current
  const previewImage = metadataComplete ? null : await fetchLinkPreviewImage(snapshot.meta)
  if (context.stale()) {
    return 'stale'
  }
  current = await context.currentCapture(identity)
  if (current === null) {
    return 'skipped'
  }
  snapshot = current
  let previewScreenshot: string | null = null
  if (previewImage !== null) {
    try {
      await writeAsset(identity.assetPath, previewImage, context.generation)
      previewScreenshot = identity.assetPath
    } catch {
      // A preview is optional; metadata enrichment still completes when
      // the local asset cannot be persisted.
    }
  }
  if (context.stale()) {
    return 'stale'
  }
  current = await context.currentCapture(identity)
  if (current === null) {
    return 'skipped'
  }
  snapshot = current
  const placeholderTitle = displayTitle({ title: '', url: snapshot.meta.captureUrl })
  const metadataTitle =
    snapshot.title === placeholderTitle && pageMeta?.title
      ? normalizedPageTitle(pageMeta.title)
      : null
  const metadataDisplayTitle = metadataTitle ?? snapshot.title
  const metadataDescription = hasDescription(snapshot.body) ? null : (pageMeta?.description ?? null)
  let metadataBody =
    metadataDescription !== null
      ? withDescription(snapshot.body, metadataDescription)
      : snapshot.body
  if (metadataTitle !== null) {
    metadataBody = withTitle(metadataBody, metadataTitle)
  }
  if (previewScreenshot !== null) {
    metadataBody = withScreenshot(metadataBody, metadataDisplayTitle, previewScreenshot)
  }

  if (config === null) {
    const titleChanged = metadataDisplayTitle !== snapshot.title
    // Two persists on purpose: the retitle commits as `pending` first so
    // an interrupted Daily write resumes as `pending`, letting a provider
    // configured between passes still run AI on this capture. Only after
    // the retitle fully lands does the second persist stamp `done`.
    const captureHash = await persistCaptureEnrichment({
      identity,
      expectedHash: snapshot.meta.captureHash,
      body: metadataBody,
      fromTitle: snapshot.title,
      toTitle: metadataDisplayTitle,
      status: titleChanged ? 'pending' : 'done',
      provider: null,
      screenshot: previewScreenshot ?? undefined,
      generation: context.generation,
    })
    if (captureHash === null) {
      await context.skipPending(identity)
      return 'skipped'
    }
    if (titleChanged) {
      const finalizedHash = await persistCaptureEnrichment({
        identity,
        expectedHash: captureHash,
        body: metadataBody,
        fromTitle: metadataDisplayTitle,
        toTitle: metadataDisplayTitle,
        status: 'done',
        provider: null,
        generation: context.generation,
      })
      if (finalizedHash === null) {
        await context.skipPending(identity)
        return 'skipped'
      }
    }
    return 'enriched'
  }

  let metadataHash = snapshot.meta.captureHash
  if (!metadataComplete) {
    const persistedHash = await persistCaptureEnrichment({
      identity,
      expectedHash: snapshot.meta.captureHash,
      body: metadataBody,
      fromTitle: snapshot.title,
      toTitle: metadataDisplayTitle,
      status: 'pending',
      provider: null,
      screenshot: previewScreenshot ?? undefined,
      generation: context.generation,
    })
    if (persistedHash === null) {
      await context.skipPending(identity)
      return 'skipped'
    }
    metadataHash = persistedHash
  }
  if (context.stale()) {
    return 'stale'
  }
  if (apiKey === null) {
    return 'waiting-for-key'
  }

  current = await context.currentCapture(identity, metadataHash)
  if (current === null) {
    return 'skipped'
  }
  snapshot = current
  const screenshotBase64 = await readCaptureScreenshot(snapshot.meta, context.generation)
  if (context.stale()) {
    return 'stale'
  }
  current = await context.currentCapture(identity, metadataHash)
  if (current === null) {
    return 'skipped'
  }
  snapshot = current
  const generated = await generateEnrichment({
    config,
    apiKey,
    fetchFn: context.fetchFn,
    meta: snapshot.meta,
    title: snapshot.title,
    scraped: pageMeta,
    body: snapshot.body,
    screenshotBase64,
  })
  if (context.stale()) {
    return 'stale'
  }

  current = await context.currentCapture(identity, metadataHash)
  if (current === null) {
    return 'skipped'
  }
  snapshot = current
  const aiTitle = generated?.title ?? null
  const enrichedTitle = aiTitle ?? snapshot.title
  const description = generated?.description ?? null

  const usedAiDescription = description !== null && metadataValue(description) !== ''
  const usedAi = usedAiDescription || aiTitle !== null
  let newBody = usedAiDescription ? withDescription(snapshot.body, description) : snapshot.body
  if (aiTitle !== null) {
    newBody = withTitle(newBody, aiTitle)
  }
  const captureHash = await persistCaptureEnrichment({
    identity,
    expectedHash: metadataHash,
    body: newBody,
    fromTitle: snapshot.title,
    toTitle: enrichedTitle,
    status: 'done',
    provider: usedAi ? config : null,
    generation: context.generation,
  })
  if (captureHash === null) {
    await context.skipPending(identity)
    return 'skipped'
  }
  return 'enriched'
}
