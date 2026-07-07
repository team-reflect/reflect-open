import { useEffect, useRef } from 'react'
import { embedNote, embedRemove, isNotePath, subscribeIndexApplied } from '@reflect/core'
import {
  backfillEmbeddingsVisibly,
  consumeLegacySemanticOptIn,
  ensureEmbeddingsVisibly,
} from '@/lib/semantic'
import { useEmbedStatus } from '@/lib/use-embed-status'
import { isMainWindow } from '@/lib/windows/window-role'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * Keeps embeddings in sync with the graph (Plan 09). Renders nothing; mounted
 * once per workspace. Three jobs:
 *
 * - load the model whenever `semanticSearchEnabled` is on and the runtime is
 *   untouched — at launch for users who opted in earlier (the cache makes
 *   that instant) and the moment the setting flips on (the one place the
 *   first download starts);
 * - run one incremental backfill per graph-open once `ready` (hash-skip makes
 *   this cheap when nothing changed);
 * - follow the index: changed notes re-embed, deleted notes drop vectors.
 *   Work is serialized on one queue so passes can't interleave.
 *
 * The follow trigger is `subscribeIndexApplied` — the post-apply signal — not
 * the raw watcher stream, for two reasons. Ordering: `embed_apply` drops
 * chunks for paths without a `notes` row, so embedding a brand-new note off
 * the raw file event could race its index apply and lose the chunks until the
 * next backfill; post-apply, the row is always there. Coverage: asset
 * description writes re-index their referencing notes *outside* the watcher
 * pipeline (`reindexNotesReferencing` emits the same signal), and those notes
 * must re-embed for the description text to reach semantic search.
 *
 * Backfill and follow work need the runtime `ready` *and* the setting on:
 * disabling semantic search pauses embedding work immediately (the loaded
 * model just idles for the rest of the session), and re-enabling catches up
 * via the cheap hash-skip backfill.
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
  // Main window only: a secondary note window loading the model and
  // re-embedding on the same watcher stream would duplicate every write.
  const enabled = settings.semanticSearchEnabled && isMainWindow()
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

  // One backfill per (graph, model) once ready, then live post-apply
  // follow-up. `enabled` is part of the gate so a mid-session disable tears
  // this down: pending queue items see `active` go false and skip, and the
  // subscription drops.
  useEffect(() => {
    if (!enabled || !ready || generation === null || root === null || modelId === null) {
      return
    }
    let active = true

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
        // A rejection here must not poison the queue (later change items
        // chain off this promise) nor masquerade as a per-change failure.
        console.error('embedding backfill failed:', cause)
      })

    const unlisten = subscribeIndexApplied((changes, appliedGeneration) => {
      if (!active || appliedGeneration !== generation) {
        return // torn down, or a delayed emit from a superseded index session
      }
      for (const change of changes) {
        if (!isNotePath(change.path)) {
          continue // asset-file changes ride the same batches — never embedded
        }
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
    })

    return () => {
      active = false
      unlisten()
    }
  }, [enabled, ready, generation, root, modelId])

  return null
}
