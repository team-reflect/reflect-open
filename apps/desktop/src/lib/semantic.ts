import {
  backfillEmbeddings,
  embedEnsure,
  embedStatus,
  subscribeEmbedStatus,
  type EmbedStatus,
} from '@reflect/core'
import { startOperation } from '@/lib/operations'

/**
 * Semantic-search loading (Plan 09). The model is ~90MB and downloads from
 * the network, so it is **opt-in**: the `semanticSearchEnabled` setting flips
 * the persisted opt-in and `EmbeddingsSync` kicks the first download; later
 * launches auto-load from the local cache because the flag is set.
 * Acceptance: "first semantic use downloads the model with progress; later
 * uses are instant."
 */

/** Where the opt-in lived before it moved into the settings document. */
const LEGACY_ENABLED_KEY = 'reflect.semantic.enabled'

/**
 * Read-and-clear the pre-settings localStorage opt-in. Returns true exactly
 * once for a user who enabled semantic search before the flag moved into
 * settings — the caller persists it there and the key never matters again.
 */
export function consumeLegacySemanticOptIn(): boolean {
  try {
    const enabled = localStorage.getItem(LEGACY_ENABLED_KEY) === 'true'
    localStorage.removeItem(LEGACY_ENABLED_KEY)
    return enabled
  } catch {
    return false
  }
}

/**
 * Resolve once the runtime reaches a terminal state. `embed_ensure` returns
 * `loading` to a caller that raced an in-flight load — the event stream (plus
 * a re-poll, in case the terminal event fired between the two) carries the
 * real outcome.
 */
async function awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus> {
  if (initial.status === 'ready' || initial.status === 'failed') {
    return initial
  }
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null
    let settled = false
    const settle = (status: EmbedStatus): void => {
      if (!settled && (status.status === 'ready' || status.status === 'failed')) {
        settled = true
        unlisten?.()
        resolve(status)
      }
    }
    void subscribeEmbedStatus(settle).then((fn) => {
      if (settled) {
        fn()
        return
      }
      unlisten = fn
      // The terminal event may have fired before the subscription landed.
      void embedStatus().then(settle)
    })
  })
}

/**
 * Re-kick a `failed` model load; a no-op for every other status. The explicit
 * enable actions (settings button, `semantic.enable` command) run this so
 * opting back in after a failure retries the download — EmbeddingsSync itself
 * only loads an `uninitialized` runtime, because reacting to `failed` would
 * loop a broken download forever.
 */
export async function retryFailedEmbeddings(): Promise<void> {
  const status = await embedStatus()
  if (status.status === 'failed') {
    await ensureEmbeddingsVisibly()
  }
}

/** Load (downloading if needed) the model, visibly. Resolves with the outcome. */
export async function ensureEmbeddingsVisibly(): Promise<EmbedStatus> {
  const operation = startOperation('Loading semantic search model')
  try {
    const status = await awaitTerminalStatus(await embedEnsure())
    if (status.status === 'failed') {
      operation.fail(status.message)
    } else {
      operation.done()
    }
    return status
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    operation.fail(message)
    return { status: 'failed', message }
  }
}

/** Embed every indexed note (incremental — the hash-skip makes re-runs cheap). */
export async function backfillEmbeddingsVisibly(options: {
  generation: number
  modelId: string
  isStale?: () => boolean
}): Promise<'completed' | 'aborted' | 'failed'> {
  const operation = startOperation('Indexing notes for semantic search')
  try {
    const outcome = await backfillEmbeddings({
      ...options,
      onProgress: (done, total) => operation.progress(done, total),
    })
    // Either way the entry leaves the status surface (there is no "finished"
    // state to misreport) — but an abort is the caller's signal that this
    // pass didn't cover the graph; the next ready cycle re-runs it cheaply.
    operation.done()
    return outcome
  } catch (cause) {
    operation.fail(cause instanceof Error ? cause.message : String(cause))
    return 'failed'
  }
}
