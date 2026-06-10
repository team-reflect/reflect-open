import { useEffect, useRef } from 'react'
import { embedNote, embedRemove, subscribeFileChanges } from '@reflect/core'
import { backfillEmbeddingsVisibly, ensureEmbeddingsVisibly, semanticEnabled } from '@/lib/semantic'
import { useEmbedStatus } from '@/lib/use-embed-status'
import { useGraph } from '@/providers/graph-provider'

/**
 * Keeps embeddings in sync with the graph (Plan 09). Renders nothing; mounted
 * once per workspace. Three jobs, all gated on the runtime being `ready`:
 *
 * - auto-load the model on launch when semantic search was previously enabled
 *   (the cache makes this instant; the first download only ever happens via
 *   the explicit `semantic.enable` command);
 * - run one incremental backfill per graph-open once `ready` (hash-skip makes
 *   this cheap when nothing changed);
 * - follow the watcher: changed notes re-embed, deleted notes drop vectors.
 *   Work is serialized on one queue so passes can't interleave.
 */
export function EmbeddingsSync(): null {
  const { graph } = useGraph()
  const status = useEmbedStatus()
  const queue = useRef<Promise<void>>(Promise.resolve())

  const generation = graph?.generation ?? null
  const root = graph?.root ?? null
  const ready = status.status === 'ready'
  const modelId = status.status === 'ready' ? status.model : null

  // Auto-load on launch for users who opted in earlier.
  useEffect(() => {
    if (status.status === 'uninitialized' && semanticEnabled()) {
      void ensureEmbeddingsVisibly()
    }
  }, [status.status])

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
