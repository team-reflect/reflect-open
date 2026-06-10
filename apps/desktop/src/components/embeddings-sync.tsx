import { useEffect, useRef } from 'react'
import { embedNote, embedRemove, subscribeFileChanges } from '@reflect/core'
import {
  backfillEmbeddingsVisibly,
  consumeLegacySemanticOptIn,
  ensureEmbeddingsVisibly,
} from '@/lib/semantic'
import { useEmbedStatus } from '@/lib/use-embed-status'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * Keeps embeddings in sync with the graph (Plan 09). Renders nothing; mounted
 * once per workspace. Three jobs, all gated on the runtime being `ready`:
 *
 * - load the model whenever `semanticSearchEnabled` is on and the runtime is
 *   untouched — at launch for users who opted in earlier (the cache makes
 *   that instant) and the moment the setting flips on (the one place the
 *   first download starts);
 * - run one incremental backfill per graph-open once `ready` (hash-skip makes
 *   this cheap when nothing changed);
 * - follow the watcher: changed notes re-embed, deleted notes drop vectors.
 *   Work is serialized on one queue so passes can't interleave.
 */
export function EmbeddingsSync(): null {
  const { graph, indexGeneration } = useGraph()
  const { settings, updateSettings } = useSettings()
  const status = useEmbedStatus()
  const queue = useRef<Promise<void>>(Promise.resolve())

  // embed_apply/embed_remove are gated on the INDEX session generation, not
  // the file-write generation in GraphInfo — the counters are independent.
  const generation = indexGeneration
  const root = graph?.root ?? null
  const enabled = settings.semanticSearchEnabled
  const ready = status.status === 'ready'
  const modelId = status.status === 'ready' ? status.model : null

  // The opt-in predates the settings document (it lived in localStorage);
  // carry it over once so those users keep semantic search across the move.
  useEffect(() => {
    if (consumeLegacySemanticOptIn()) {
      updateSettings({ semanticSearchEnabled: true })
    }
  }, [updateSettings])

  // Load while enabled and untouched. Deliberately not retried on `failed`:
  // an automatic loop would hammer a broken download — recovery rides the
  // explicit enable/retry actions instead (see retryFailedEmbeddings).
  useEffect(() => {
    if (enabled && status.status === 'uninitialized') {
      void ensureEmbeddingsVisibly()
    }
  }, [enabled, status.status])

  // One backfill per (graph, model) once ready, then live watcher follow-up.
  useEffect(() => {
    if (!ready || generation === null || root === null || modelId === null) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null

    queue.current = queue.current
      .then(() => {
        if (!active) {
          return
        }
        return backfillEmbeddingsVisibly({ generation, modelId, isStale: () => !active }).then(
          () => {},
        )
      })
      .catch((cause) => {
        // A rejection here must not poison the queue (later watcher items
        // chain off this promise) nor masquerade as a per-change failure.
        console.error('embedding backfill failed:', cause)
      })

    void subscribeFileChanges((changes) => {
      if (!active) {
        return
      }
      for (const change of changes) {
        queue.current = queue.current
          .then(() => {
            if (!active) {
              return
            }
            return change.kind === 'remove'
              ? embedRemove(change.path, generation)
              : embedNote({ path: change.path, generation, modelId }).then(() => {})
          })
          .catch((cause) => {
            console.error(`embedding sync failed for ${change.path}:`, cause)
          })
      }
    }).then((fn) => {
      if (active) {
        unlisten = fn
      } else {
        fn()
      }
    })

    return () => {
      active = false
      unlisten?.()
    }
  }, [ready, generation, root, modelId])

  return null
}
