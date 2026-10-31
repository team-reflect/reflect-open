import { captureFromPath, type CaptureIdentity } from './capture-identity.ts'
import { sha256Hex } from '@reflect/utils'
import {
  captureDescriptionFromBody,
  captureNoteMeta,
  capturePageTextFromBody,
  displayTitle,
  hasDescription,
  metadataValue,
  noteSource,
  withDescription,
  withScreenshot,
  withTitle,
  type CaptureNoteMeta,
} from './capture-note.ts'
import { notePrivate, type PrivacyService } from '../privacy/privacy-service.ts'
import type { AiCredentialService } from '../ai/ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai/ai-provider-config-service.ts'
import {
  isDescriptionRejected,
  normalizedPageTitle,
  type PageDescriberService,
  type PageEnrichment,
} from '../ai/page-describer-service.ts'
import type { ReconcileStop } from '../reconcile/reconcile.ts'
import type { WebFetchService } from '../link-preview/web-fetch-service.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dailyPath } from '../graph/paths.ts'
import type { PageMeta } from '../link-preview/metadata.ts'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import {
  finishCaptureWrite,
  hasCaptureWriteTransaction,
  persistCaptureEnrichment,
  readPendingCaptureSnapshot,
  type CaptureWriteContext,
  type PendingCaptureSnapshot,
} from './capture-enrichment-write.ts'
import type { PageMetaService } from './page-meta-service.ts'

export interface ReconcileCaptureEnrichmentInput {
  /**
   * `GraphInfo.generation`, pins every read and write to the issuing graph.
   */
  generation: number
  /**
   * Abort gate, checked between notes and after every slow await.
   */
  isStale?: () => boolean
  /**
   * Observes how many captures need enrichment, before work starts.
   */
  onPending?: (count: number) => void
}

export interface ReconcileCaptureEnrichmentOutcome {
  /**
   * Captures that were pending when the pass started.
   */
  pending: number
  /**
   * Captures this pass enriched (meta tags, plus AI when configured).
   */
  enriched: number
  /**
   * Captures marked skipped (made private, or edited since the raw save).
   */
  skipped: number
  /**
   * Why captures remain pending, or `null` when the pass drained.
   */
  stopped: ReconcileStop | null
}

interface GenerateEnrichmentInput {
  config: AiProviderConfig
  apiKey: string
  /**
   * The pending capture's frontmatter keys (URL, screenshot asset).
   */
  meta: CaptureNoteMeta
  /**
   * The note's current display title.
   */
  title: string
  scraped: PageMeta | null
  /**
   * The raw drain-written body (page text is extracted from it).
   */
  body: string
  screenshotBase64?: string | undefined
}

export interface CaptureEnrichmentServiceDeps {
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  readonly webFetch: WebFetchService
  readonly pageMeta: PageMetaService
  readonly pageDescriber: PageDescriberService
  readonly aiProviderConfig: AiProviderConfigService
  readonly aiCredentials: AiCredentialService
  readonly privacy: PrivacyService
}

/**
 * Phase 2 of link capture: meta scrape plus the optional BYOK description.
 */
export interface CaptureEnrichmentService {
  /**
   * Capture notes still awaiting enrichment, oldest first: well-formed capture
   * notes whose frontmatter says `captureStatus: pending`.
   */
  listPending(generation: number): Promise<CaptureIdentity[]>
  /**
   * Enrich every pending capture: scrape the page's description and display
   * title and persist those before the optional AI call. A provider failure
   * therefore leaves a useful capture pending for retry instead of hiding the
   * metadata work; a completed/no-provider pass stamps `captureStatus: done`.
   * Never throws.
   */
  reconcile(input: ReconcileCaptureEnrichmentInput): Promise<ReconcileCaptureEnrichmentOutcome>
}

class CaptureEnrichmentServiceImpl implements CaptureEnrichmentService {
  readonly #deps: CaptureEnrichmentServiceDeps
  readonly #writes: CaptureWriteContext

  constructor(deps: CaptureEnrichmentServiceDeps) {
    this.#deps = deps
    this.#writes = { noteFile: deps.noteFile }
  }

  async listPending(generation: number): Promise<CaptureIdentity[]> {
    const { noteFile } = this.#deps
    const files = await noteFile.listNotes(generation)
    const candidates = files
      .map((file) => captureFromPath(file.path))
      .filter((identity): identity is CaptureIdentity => identity !== null)
      .sort((first, second) => first.base.localeCompare(second.base))
    const pending: CaptureIdentity[] = []
    for (const identity of candidates) {
      let source: string
      try {
        source = await noteFile.read(identity.notePath, generation)
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

  async reconcile(
    input: ReconcileCaptureEnrichmentInput,
  ): Promise<ReconcileCaptureEnrichmentOutcome> {
    const { noteFile, assetStore, aiProviderConfig, aiCredentials } = this.#deps
    const pageMetaService = this.#deps.pageMeta
    const writes = this.#writes
    let pending: CaptureIdentity[]
    try {
      pending = await this.listPending(input.generation)
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

    const config = aiProviderConfig.defaultProvider()
    let apiKey: string | null = null
    let providerStop: ReconcileStop | null = null
    if (config !== null) {
      try {
        apiKey = await aiCredentials.read(config)
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
    let transientStop: ReconcileStop | null = null
    const stale = (): boolean => input.isStale?.() === true
    const outcome = (stopped: ReconcileStop | null): ReconcileCaptureEnrichmentOutcome => ({
      pending: pending.length,
      enriched,
      skipped,
      stopped,
    })
    const markSkipped = async (source: string, identity: CaptureIdentity): Promise<void> => {
      await noteFile.write(
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
      const snapshot = await readPendingCaptureSnapshot(writes, identity, input.generation)
      if (snapshot !== null) {
        await markSkipped(snapshot.source, identity)
      }
    }
    const currentCapture = async (
      identity: CaptureIdentity,
      expectedHash?: string,
    ): Promise<PendingCaptureSnapshot | null> => {
      const snapshot = await readPendingCaptureSnapshot(writes, identity, input.generation)
      if (snapshot === null) {
        return null
      }
      const dailySource = await noteSource(noteFile, dailyPath(identity.date), input.generation)
      const bodyHash = await sha256Hex(snapshot.body)
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
          const finalized = await finishCaptureWrite(writes, identity, input.generation)
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
          const captureHash = await persistCaptureEnrichment(writes, {
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
          const captureUrl = this.#cloudSafeCaptureUrl(identity, snapshot)
          try {
            pageMeta = await pageMetaService.scrape(captureUrl)
          } catch (cause) {
            const kind = toAppError(cause).kind
            if (kind === 'network' || kind === 'auth') {
              throw cause
            }
            // Invalid URLs, non-HTML responses, and non-retryable statuses are
            // permanent for this capture; checkpoint the no-metadata result.
            // (Rate limits and server errors arrive as `network` and retry.)
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
        const previewImage = metadataComplete
          ? null
          : await this.#fetchLinkPreviewImage(
              snapshot.meta,
              this.#cloudSafeCaptureUrl(identity, snapshot),
            )
        if (stale()) {
          return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
        }
        snapshot = await currentCapture(identity)
        if (snapshot === null) {
          continue
        }
        let previewScreenshot: string | null = null
        if (previewImage !== null) {
          try {
            await assetStore.writeBase64(identity.assetPath, previewImage, input.generation)
            previewScreenshot = identity.assetPath
          } catch {
            // A preview is optional; metadata enrichment still completes when
            // the local asset cannot be persisted.
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
            ? normalizedPageTitle(pageMeta.title)
            : null
        const metadataDisplayTitle = metadataTitle ?? snapshot.title
        const metadataDescription = hasDescription(snapshot.body)
          ? null
          : (pageMeta?.description ?? null)
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
          const captureHash = await persistCaptureEnrichment(writes, {
            identity,
            expectedHash: snapshot.meta.captureHash,
            body: metadataBody,
            fromTitle: snapshot.title,
            toTitle: metadataDisplayTitle,
            status: titleChanged ? 'pending' : 'done',
            provider: null,
            screenshot: previewScreenshot ?? undefined,
            generation: input.generation,
          })
          if (captureHash === null) {
            await skipPending(identity)
            continue
          }
          if (titleChanged) {
            const finalizedHash = await persistCaptureEnrichment(writes, {
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
          const persistedHash = await persistCaptureEnrichment(writes, {
            identity,
            expectedHash: snapshot.meta.captureHash,
            body: metadataBody,
            fromTitle: snapshot.title,
            toTitle: metadataDisplayTitle,
            status: 'pending',
            provider: null,
            screenshot: previewScreenshot ?? undefined,
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
        const screenshotBase64 = await this.#readCaptureScreenshot(snapshot.meta, input.generation)
        if (stale()) {
          return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
        }
        snapshot = await currentCapture(identity, metadataHash)
        if (snapshot === null) {
          continue
        }
        const generated: PageEnrichment | null = await this.#generateEnrichment({
          config,
          apiKey,
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
        let newBody = usedAiDescription
          ? withDescription(snapshot.body, description)
          : snapshot.body
        if (aiTitle !== null) {
          newBody = withTitle(newBody, aiTitle)
        }
        const captureHash = await persistCaptureEnrichment(writes, {
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
        const error = toAppError(cause)
        // A transient failure — offline, a rate-limited page, an unavailable
        // provider — leaves this capture pending for the next pass, but must
        // not starve the captures queued behind it. Anything else (auth, an
        // unexpected write failure) affects every capture alike, so it aborts
        // the pass.
        if (error.kind === 'network') {
          transientStop ??= { reason: error.kind, message: errorMessage(cause) }
          continue
        }
        return outcome({ reason: error.kind, message: errorMessage(cause) })
      }
    }
    // `waitingForKey` is only ever set when a provider is configured without a
    // usable key, which is exactly when `providerStop` was populated above. It
    // outranks a transient stop: a keychain failure is persistent and surfaced
    // to the user, and a silent network stop must not mask it.
    return outcome((waitingForKey ? providerStop : null) ?? transientStop)
  }

  /**
   * The capture's URL as the outbound fetches may see it. Every caller holds a
   * snapshot that already passed the note and daily privacy checks.
   */
  #cloudSafeCaptureUrl(
    identity: CaptureIdentity,
    snapshot: PendingCaptureSnapshot,
  ): CloudSafe<string> {
    const { privacy } = this.#deps
    return privacy.cloudSafeLinkHref(
      { path: identity.notePath, isPrivate: snapshot.isPrivate },
      snapshot.meta.captureUrl,
    )
  }

  /**
   * The AI leg of one capture's enrichment: make the one-shot provider call and
   * treat a provider refusal as "no enrichment" (`null`) — the scraped meta is
   * the fallback. Transient failures (`auth`, `network`) propagate for retry.
   */
  async #generateEnrichment(input: GenerateEnrichmentInput): Promise<PageEnrichment | null> {
    try {
      return await this.#deps.pageDescriber.describe({
        config: input.config,
        apiKey: input.apiKey,
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

  async #readCaptureScreenshot(
    meta: CaptureNoteMeta,
    generation: number,
  ): Promise<string | undefined> {
    if (!meta.captureScreenshot) {
      return undefined
    }
    try {
      return await this.#deps.assetStore.readBase64(meta.captureScreenshot, generation)
    } catch (cause) {
      if (!isAppError(cause) || cause.kind !== 'notFound') {
        throw cause
      }
      return undefined
    }
  }

  async #fetchLinkPreviewImage(
    meta: CaptureNoteMeta,
    url: CloudSafe<string>,
  ): Promise<string | null> {
    if (meta.captureScreenshot) {
      return null
    }
    try {
      return await this.#deps.webFetch.fetchLinkPreviewImage(url)
    } catch {
      return null
    }
  }
}

export function createCaptureEnrichmentService(
  deps: CaptureEnrichmentServiceDeps,
): CaptureEnrichmentService {
  return new CaptureEnrichmentServiceImpl(deps)
}
