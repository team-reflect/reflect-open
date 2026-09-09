import { defaultAiProvider, type AiProvidersState } from '../ai/provider-config'
import { aiApiKeyForConfig } from '../ai/secrets'
import { errorMessage, isAppError, toAppError } from '../errors'
import { listFiles, readNote } from '../graph/commands'
import { parseFrontmatter, splitFrontmatter } from '../markdown/frontmatter'
import type { ReconcileStop } from './audio-memo'
import {
  createEnrichmentContext,
  type EnrichmentContext,
  type EnrichmentResult,
} from './capture-enrichment-context'
import {
  finishCaptureWrite,
  hasCaptureWriteTransaction,
  type PendingCaptureSnapshot,
} from './capture-enrichment-write'
import { captureFromPath, type CaptureIdentity } from './capture-identity'
import { captureNoteMeta } from './capture-note'
import { enrichLinkCapture, type LinkEnrichmentContext } from './link-enrichment'
import { enrichPostCapture } from './post-enrichment'
import { postCaptureMeta } from './post-meta'

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

interface ResolvedProvider {
  config: LinkEnrichmentContext['config']
  apiKey: string | null
  /** Why the key is unavailable, when a provider is configured without one. */
  stop: ReconcileStop | null
}

/** The default provider and its key, or why the key could not be read. */
async function resolveProvider(providers: AiProvidersState): Promise<ResolvedProvider> {
  const config = defaultAiProvider(providers)
  if (config === null) {
    return { config: null, apiKey: null, stop: null }
  }
  try {
    const apiKey = await aiApiKeyForConfig(config)
    return {
      config,
      apiKey,
      stop:
        apiKey === null
          ? {
              reason: 'config',
              message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
            }
          : null,
    }
  } catch (cause) {
    const error = toAppError(cause)
    return { config, apiKey: null, stop: { reason: error.kind, message: error.message } }
  }
}

/**
 * Finish a retitle a prior pass left half-written, if any. Returns the
 * snapshot to continue from, `'done'` when the resume completed the
 * capture, or `null` when it is no longer pending.
 */
async function resumeCaptureWrite(
  context: EnrichmentContext,
  identity: CaptureIdentity,
  snapshot: PendingCaptureSnapshot,
): Promise<PendingCaptureSnapshot | 'done' | null> {
  if (!hasCaptureWriteTransaction(snapshot.meta)) {
    return snapshot
  }
  const finalized = await finishCaptureWrite(identity, context.generation)
  if (finalized === null) {
    await context.skipPending(identity)
    return null
  }
  if (finalized === 'done') {
    return 'done'
  }
  return await context.currentCapture(identity)
}

/**
 * Enrich every pending capture: link captures scrape the page's description
 * and display title and persist those before the optional AI call; post
 * captures fetch the post and download its media. A provider failure leaves
 * a useful capture pending for retry instead of hiding the metadata work; a
 * completed/no-provider pass stamps `captureStatus: done`. Never throws.
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

  const provider = await resolveProvider(input.providers)
  let enriched = 0
  let skipped = 0
  let waitingForKey = false
  let transientStop: ReconcileStop | null = null
  const context = createEnrichmentContext({
    generation: input.generation,
    isStale: input.isStale,
    onSkipped: () => {
      skipped += 1
    },
  })
  const linkContext: LinkEnrichmentContext = {
    ...context,
    config: provider.config,
    apiKey: provider.apiKey,
    fetchFn: input.fetchFn,
  }
  const outcome = (stopped: ReconcileStop | null): ReconcileCaptureEnrichmentOutcome => ({
    pending: pending.length,
    enriched,
    skipped,
    stopped,
  })
  const staleStop: ReconcileStop = { reason: 'stale', message: 'the graph session ended mid-pass' }

  for (const identity of pending) {
    if (context.stale()) {
      return outcome(staleStop)
    }
    try {
      const current = await context.currentCapture(identity)
      if (current === null) {
        continue
      }
      const resumed = await resumeCaptureWrite(context, identity, current)
      if (resumed === null) {
        continue
      }
      if (resumed === 'done') {
        enriched += 1
        continue
      }
      const result: EnrichmentResult =
        postCaptureMeta(resumed.meta) !== null
          ? await enrichPostCapture(context, identity, resumed)
          : await enrichLinkCapture(linkContext, identity, resumed)
      if (result === 'stale') {
        return outcome(staleStop)
      }
      if (result === 'enriched') {
        enriched += 1
      } else if (result === 'waiting-for-key') {
        waitingForKey = true
      }
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
  // usable key, which is exactly when `provider.stop` was populated above. It
  // outranks a transient stop: a keychain failure is persistent and surfaced
  // to the user, and a silent network stop must not mask it.
  return outcome((waitingForKey ? provider.stop : null) ?? transientStop)
}
