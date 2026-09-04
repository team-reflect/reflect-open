import { useEffect, useRef } from 'react'
import { embedNote, isNotePath, subscribeIndexApplied } from '@reflect/core'
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
 * - select dirty embedding work once per graph-open after `ready`;
 * - follow the index: changed notes re-embed, deleted notes drop vectors.
 *   Live paths coalesce and run between bulk notes on one serialized queue.
 *
 * The follow trigger is `subscribeIndexApplied` — the post-apply signal — not
 * the raw watcher stream, for two reasons. Ordering: embedding commands
 * require an indexed note revision, so embedding a brand-new note off the
 * raw file event could race its index apply and skip the note until the next
 * backfill; post-apply, the row is always there. Coverage: asset
 * description writes re-index their referencing notes *outside* the watcher
 * pipeline (`reindexNotesReferencing` emits the same signal), and those notes
 * must re-embed for the description text to reach semantic search.
 *
 * Backfill and follow work need the runtime `ready` *and* the setting on:
 * disabling semantic search pauses embedding work immediately (the loaded
 * model just idles for the rest of the session), and re-enabling catches up
 * via the persisted dirty-work check.
 */
export function EmbeddingsSync(): null {
  const { graph, indexGeneration } = useGraph()
  const { settings, updateSettings } = useSettings()
  const status = useEmbedStatus()
  const queue = useRef<Promise<void>>(Promise.resolve())

  // Embedding commands are gated on the INDEX session generation, not
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
    let liveQueued = false
    const pending = new Set<string>()
    const isStale = (): boolean => !active

    const drainLive = async (): Promise<void> => {
      while (active && pending.size > 0) {
        const path = pending.values().next().value
        if (path === undefined) {
          break
        }
        pending.delete(path)
        try {
          await embedNote({ path, generation, modelId, isStale })
        } catch (cause) {
          console.error(`embedding sync failed for ${path}:`, cause)
        }
      }
    }

    const scheduleNote = (work: () => Promise<void>): Promise<void> => {
      const scheduled = queue.current.then(async () => {
        await drainLive()
        if (active) {
          await work()
        }
      })
      // The backfill reports this note's failure; the next queued note can
      // still run, and its failed checkpoint remains retryable.
      queue.current = scheduled.catch(() => {})
      return scheduled
    }

    // Let the ready workspace render before starting bulk maintenance.
    const backfillTimer = setTimeout(() => {
      // Candidate discovery does not own the write/inference queue: live
      // saves can proceed while native scans asset-description revisions.
      void backfillEmbeddingsVisibly({ generation, modelId, isStale, scheduleNote })
    }, 0)

    const unlisten = subscribeIndexApplied((changes, appliedGeneration) => {
      if (!active || appliedGeneration !== generation) {
        return // torn down, or a delayed emit from a superseded index session
      }
      for (const change of changes) {
        if (!isNotePath(change.path)) {
          continue // asset-file changes ride the same batches — never embedded
        }
        if (change.kind === 'remove') {
          // The index transaction already removed vectors; a delayed remove
          // here could erase a newly recreated note at the same path.
          pending.delete(change.path)
        } else {
          pending.add(change.path)
        }
      }
      if (!liveQueued && pending.size > 0) {
        liveQueued = true
        queue.current = queue.current.then(async () => {
          await drainLive()
          liveQueued = false
        })
      }
    })

    return () => {
      active = false
      clearTimeout(backfillTimer)
      pending.clear()
      unlisten()
    }
  }, [enabled, ready, generation, root, modelId])

  return null
}
