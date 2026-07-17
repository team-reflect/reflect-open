import { describePage, isDescriptionRejected, type PageEnrichment } from '../ai/describe-page'
import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import { errorMessage, isAppError, toAppError } from '../errors'
import { listFiles, readAsset, readNote, writeNote } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import { getSecret } from '../secrets/keychain'
import type { AiProviderConfig } from '../settings/schema'
import type { ReconcileStop } from './audio-memo'
import {
  finishCaptureWrite,
  hasCaptureWriteTransaction,
  persistCaptureEnrichment,
  readPendingCaptureSnapshot,
  type PendingCaptureSnapshot,
} from './capture-enrichment-write'
import { captureFromPath, type CaptureIdentity } from './capture-identity'
import {
  captureDescriptionFromBody,
  captureNoteMeta,
  capturePageTextFromBody,
  displayTitle,
  hasDescription,
  metadataValue,
  notePrivate,
  noteSource,
  withDescription,
  withTitle,
  type CaptureNoteMeta,
} from './capture-note'
import { scrapePageMeta, type PageMeta } from './meta-scrape'

/**
 * Capture notes still awaiting enrichment, oldest first: well-formed capture
 * notes whose frontmatter says `captureStatus: pending`.
 */
export async function listPendingCaptures(generation: number): Promise<CaptureIdentity[]> {
  const files = await listFiles(generation)
  const candidates = files
    .map((file) => captureFromPath(file.path))
    .filter((identity): identity is CaptureIdentity => identity !== null)
    .sort((first, second) => first.base.localeCompare(second.base))
  const pending: CaptureIdentity[] = []
  for (const identity of candidates) {
    let source: string
    try {
      source = await readNote(identity.notePath, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue
      }
      throw cause
    }
    const meta = captureNoteMeta(parseFrontmatter(splitFrontmatter(source).raw).data)
    if (meta?.captureStatus === 'pending') {
      pending.push(identity)
    }
  }
  return pending
}

export interface ReconcileCaptureEnrichmentInput {
  /** The configured-providers state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** `GraphInfo.generation` — pins every read and write to the issuing graph. */
  generation: number
  /** Transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
  /** Abort gate, checked between notes and after every slow await. */
  isStale?: () => boolean
  /** Observes how many captures need enrichment, before work starts. */
  onPending?: (count: number) => void
}

export interface ReconcileCaptureEnrichmentOutcome {
  /** Captures that were pending when the pass started. */
  pending: number
  /** Captures this pass enriched (meta tags, plus AI when configured). */
  enriched: number
  /** Captures marked skipped (made private, or edited since the raw save). */
  skipped: number
  /** Why captures remain pending, or `null` when the pass drained. */
  stopped: ReconcileStop | null
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

/**
 * Enrich every pending capture: scrape the page's description and display
 * title and persist those before the optional AI call. A provider failure
 * therefore leaves a useful capture pending for retry instead of hiding the
 * metadata work; a completed/no-provider pass stamps `captureStatus: done`.
 * Never throws.
 */
export async function reconcileCaptureEnrichment(
  input: ReconcileCaptureEnrichmentInput,
): Promise<ReconcileCaptureEnrichmentOutcome> {
  let pending: CaptureIdentity[]
  try {
    pending = await listPendingCaptures(input.generation)
  } catch (cause) {
    return {
      pending: 0,
      enriched: 0,
      skipped: 0,
      stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
    }
  }
  input.onPending?.(pending.length)
  if (pending.length === 0) {
    return { pending: 0, enriched: 0, skipped: 0, stopped: null }
  }

  const config = defaultAiProvider(input.providers)
  let apiKey: string | null = null
  let providerStop: ReconcileStop | null = null
  if (config !== null) {
    try {
      apiKey = await getSecret(aiKeySecretName(config.id))
    } catch (cause) {
      const error = toAppError(cause)
      providerStop = { reason: error.kind, message: error.message }
    }
    if (apiKey === null && providerStop === null) {
      providerStop = {
        reason: 'config',
        message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
      }
    }
  }

  let enriched = 0
  let skipped = 0
  let waitingForKey = false
  const stale = (): boolean => input.isStale?.() === true
  const outcome = (stopped: ReconcileStop | null): ReconcileCaptureEnrichmentOutcome => ({
    pending: pending.length,
    enriched,
    skipped,
    stopped,
  })
  const markSkipped = async (source: string, identity: CaptureIdentity): Promise<void> => {
    await writeNote(
      identity.notePath,
      upsertFrontmatter(source, {
        captureStatus: 'skipped',
        captureDailyFromTitle: undefined,
        captureFinalizeStatus: undefined,
      }),
      input.generation,
    )
    skipped += 1
  }
  const skipPending = async (identity: CaptureIdentity): Promise<void> => {
    const snapshot = await readPendingCaptureSnapshot(identity, input.generation)
    if (snapshot !== null) {
      await markSkipped(snapshot.source, identity)
    }
  }
  const currentCapture = async (
    identity: CaptureIdentity,
    expectedHash?: string,
  ): Promise<PendingCaptureSnapshot | null> => {
    const snapshot = await readPendingCaptureSnapshot(identity, input.generation)
    if (snapshot === null) {
      return null
    }
    const dailySource = await noteSource(dailyPath(identity.date), input.generation)
    const bodyHash = await hashContent(snapshot.body)
    if (
      snapshot.isPrivate ||
      notePrivate(dailySource) ||
      bodyHash !== (expectedHash ?? snapshot.meta.captureHash)
    ) {
      await markSkipped(snapshot.source, identity)
      return null
    }
    return snapshot
  }

  for (const identity of pending) {
    if (stale()) {
      return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
    }
    try {
      let snapshot = await currentCapture(identity)
      if (snapshot === null) {
        continue
      }
      if (hasCaptureWriteTransaction(snapshot.meta)) {
        const finalized = await finishCaptureWrite(identity, input.generation)
        if (finalized === null) {
          await skipPending(identity)
          continue
        }
        if (finalized === 'done') {
          enriched += 1
          continue
        }
        snapshot = await currentCapture(identity)
        if (snapshot === null) {
          continue
        }
      }
      const metadataComplete = snapshot.meta.captureMetadataStatus === 'done'
      if (metadataComplete && apiKey === null) {
        if (config !== null) {
          waitingForKey = true
          continue
        }
        const captureHash = await persistCaptureEnrichment({
          identity,
          expectedHash: snapshot.meta.captureHash,
          body: snapshot.body,
          fromTitle: snapshot.title,
          toTitle: snapshot.title,
          status: 'done',
          provider: null,
          generation: input.generation,
        })
        if (captureHash === null) {
          await skipPending(identity)
          continue
        }
        enriched += 1
        continue
      }

      let pageMeta: PageMeta | null = null
      if (metadataComplete) {
        // Deliberately lossy resume: the checkpoint keeps only what the note
        // shows, so a retried AI call sees the current H1 as the meta title
        // and loses `siteName` — close enough that persisting the raw scrape
        // isn't worth another frontmatter field.
        pageMeta = {
          title: snapshot.title,
          description: captureDescriptionFromBody(snapshot.body) ?? null,
          siteName: null,
        }
      } else {
        try {
          pageMeta = await scrapePageMeta(snapshot.meta.captureUrl)
        } catch (cause) {
          const kind = toAppError(cause).kind
          if (kind === 'network' || kind === 'auth') {
            throw cause
          }
          // Invalid URLs, non-HTML responses, and non-success statuses are
          // permanent for this capture; checkpoint the no-metadata result.
          pageMeta = null
        }
      }
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }

      snapshot = await currentCapture(identity)
      if (snapshot === null) {
        continue
      }
      const placeholderTitle = displayTitle({ title: '', url: snapshot.meta.captureUrl })
      const metadataTitle =
        snapshot.title === placeholderTitle && pageMeta?.title
          ? displayTitle({ title: pageMeta.title, url: snapshot.meta.captureUrl })
          : null
      const metadataDisplayTitle = metadataTitle ?? snapshot.title
      const metadataDescription = hasDescription(snapshot.body)
        ? null
        : pageMeta?.description ?? null
      let metadataBody =
        metadataDescription !== null
          ? withDescription(snapshot.body, metadataDescription)
          : snapshot.body
      if (metadataTitle !== null) {
        metadataBody = withTitle(metadataBody, metadataTitle)
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
          generation: input.generation,
        })
        if (captureHash === null) {
          await skipPending(identity)
          continue
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
            generation: input.generation,
          })
          if (finalizedHash === null) {
            await skipPending(identity)
            continue
          }
        }
        enriched += 1
        continue
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
          generation: input.generation,
        })
        if (persistedHash === null) {
          await skipPending(identity)
          continue
        }
        metadataHash = persistedHash
      }
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }
      if (apiKey === null) {
        waitingForKey = true
        continue
      }

      snapshot = await currentCapture(identity, metadataHash)
      if (snapshot === null) {
        continue
      }
      const screenshotBase64 = await readCaptureScreenshot(snapshot.meta, input.generation)
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }
      snapshot = await currentCapture(identity, metadataHash)
      if (snapshot === null) {
        continue
      }
      const generated: PageEnrichment | null = await generateEnrichment({
        config,
        apiKey,
        fetchFn: input.fetchFn,
        meta: snapshot.meta,
        title: snapshot.title,
        scraped: pageMeta,
        body: snapshot.body,
        screenshotBase64,
      })
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }

      snapshot = await currentCapture(identity, metadataHash)
      if (snapshot === null) {
        continue
      }
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
        generation: input.generation,
      })
      if (captureHash === null) {
        await skipPending(identity)
        continue
      }
      enriched += 1
    } catch (cause) {
      return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
    }
  }
  // `waitingForKey` is only ever set when a provider is configured without a
  // usable key, which is exactly when `providerStop` was populated above.
  return outcome(waitingForKey ? providerStop : null)
}
