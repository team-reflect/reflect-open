import { describePage, isDescriptionRejected, type PageEnrichment } from '../ai/describe-page'
import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config'
import { aiApiKeyForConfig } from '../ai/secrets'
import { errorMessage, isAppError, toAppError } from '../errors'
import { listFiles, readAsset, readNote, writeNote } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { parseNote } from '../markdown/extract'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter'
import type { AiProviderConfig } from '../settings/schema'
import type { ReconcileStop } from './audio-memo'
import { captureFromPath, type CaptureIdentity } from './capture-identity'
import {
  captureNoteMeta,
  capturePageTextFromBody,
  hasDescription,
  metadataValue,
  notePrivate,
  noteSource,
  retitleDailyEntry,
  withDescription,
  withTitle,
  type CaptureNoteMeta,
  type CaptureStatus,
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
  generation: number
}

/**
 * The AI leg of one capture's enrichment: read the screenshot asset, make the
 * one-shot provider call, and treat a provider refusal as "no enrichment"
 * (`null`) — the scraped meta is the fallback. Transient failures (`auth`,
 * `network`) propagate for the pass to retry later.
 */
async function generateEnrichment(input: GenerateEnrichmentInput): Promise<PageEnrichment | null> {
  let screenshotBase64: string | undefined
  if (input.meta.captureScreenshot) {
    try {
      screenshotBase64 = await readAsset(input.meta.captureScreenshot, input.generation)
    } catch (cause) {
      if (!isAppError(cause) || cause.kind !== 'notFound') {
        throw cause
      }
    }
  }
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
      screenshotBase64,
    })
  } catch (cause) {
    if (!isDescriptionRejected(cause)) {
      throw cause
    }
    return null
  }
}

/**
 * Enrich every pending capture: scrape the page's meta tags, generate the AI
 * description and cleaned-up display title when a provider is configured
 * (retitling the note's H1 and the daily entry's link text), and stamp
 * `captureStatus: done`. Never throws.
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
  if (config !== null) {
    apiKey = await aiApiKeyForConfig(config)
    if (apiKey === null) {
      return {
        pending: pending.length,
        enriched: 0,
        skipped: 0,
        stopped: {
          reason: 'config',
          message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
        },
      }
    }
  }

  let enriched = 0
  let skipped = 0
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
      upsertFrontmatter(source, { captureStatus: 'skipped' }),
      input.generation,
    )
    skipped += 1
  }

  for (const identity of pending) {
    if (stale()) {
      return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
    }
    try {
      let source: string
      try {
        source = await readNote(identity.notePath, input.generation)
      } catch (cause) {
        if (isAppError(cause) && cause.kind === 'notFound') {
          continue
        }
        throw cause
      }
      const split = splitFrontmatter(source)
      const frontmatter = parseFrontmatter(split.raw).data
      const meta = captureNoteMeta(frontmatter)
      if (meta === null || meta.captureStatus !== 'pending') {
        continue
      }

      const dailySource = await noteSource(dailyPath(identity.date), input.generation)
      if (frontmatter.private || notePrivate(dailySource)) {
        await markSkipped(source, identity)
        continue
      }
      if ((await hashContent(split.body)) !== meta.captureHash) {
        await markSkipped(source, identity)
        continue
      }

      let pageMeta: PageMeta | null = null
      try {
        pageMeta = await scrapePageMeta(meta.captureUrl)
      } catch (cause) {
        const kind = toAppError(cause).kind
        if (kind === 'network' || kind === 'auth') {
          throw cause
        }
        pageMeta = null
      }
      if (stale()) {
        return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
      }

      const title = parseNote({ path: identity.notePath, source }).title
      let generated: PageEnrichment | null = null
      if (config !== null && apiKey !== null) {
        generated = await generateEnrichment({
          config,
          apiKey,
          fetchFn: input.fetchFn,
          meta,
          title,
          scraped: pageMeta,
          body: split.body,
          generation: input.generation,
        })
        if (stale()) {
          return outcome({ reason: 'stale', message: 'the graph session ended mid-pass' })
        }
      }
      const aiTitle = generated?.title ?? null
      const description = generated?.description ?? null

      const usedAiDescription = description !== null && metadataValue(description) !== ''
      const usedAi = (usedAiDescription || aiTitle !== null) && config !== null
      const text = usedAiDescription
        ? description
        : hasDescription(split.body)
          ? null
          : pageMeta?.description ?? null
      let newBody = text !== null ? withDescription(split.body, text) : split.body
      if (aiTitle !== null) {
        newBody = withTitle(newBody, aiTitle)
      }
      const reassembled = source.slice(0, split.bodyOffset) + newBody
      await writeNote(
        identity.notePath,
        upsertFrontmatter(reassembled, {
          captureStatus: 'done' satisfies CaptureStatus,
          captureHash: await hashContent(newBody),
          captureProvider: usedAi ? config.provider : undefined,
          captureModel: usedAi ? config.model : undefined,
        }),
        input.generation,
      )
      if (aiTitle !== null && aiTitle !== title) {
        // Re-read the daily: the provider call above is slow, and the
        // pre-call snapshot would silently drop anything written meanwhile.
        const freshDaily = await noteSource(dailyPath(identity.date), input.generation)
        const retitled = retitleDailyEntry(freshDaily, identity.base, title, aiTitle)
        if (retitled !== freshDaily) {
          await writeNote(dailyPath(identity.date), retitled, input.generation)
        }
      }
      enriched += 1
    } catch (cause) {
      return outcome({ reason: toAppError(cause).kind, message: errorMessage(cause) })
    }
  }
  return outcome(null)
}
