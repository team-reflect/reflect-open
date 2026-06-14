import { embedStatus, errorMessage, rebuildIndex } from '@reflect/core'
import { startOperation } from '@/lib/operations'
import { invalidateIndexQueries } from '@/lib/query-client'
import { backfillEmbeddingsVisibly } from '@/lib/semantic'

let inFlight: { generation: number; promise: Promise<void> } | null = null

/**
 * Full index rebuild with user-visible status: wipe and re-derive the SQLite
 * projection from the markdown files, refresh the query caches, and re-embed
 * if semantic search is on. Shared by the `index.rebuild` palette command and
 * the settings page's Rebuild index button so the whole recipe stays one
 * definition. The index is a rebuildable cache — a full rebuild is always
 * safe and never touches the notes themselves.
 *
 * Requests coalesce while a rebuild runs: a second call at the same
 * generation (a double-click, or the palette and the settings button racing)
 * returns the in-flight pass instead of starting an overlapping wipe. A call
 * at a *different* generation starts fresh — the graph changed, and Rust's
 * generation gate drops the superseded pass's writes anyway.
 */
export function rebuildIndexVisibly(generation: number): Promise<void> {
  if (inFlight !== null && inFlight.generation === generation) {
    return inFlight.promise
  }
  const promise = runRebuild(generation).finally(() => {
    if (inFlight !== null && inFlight.promise === promise) {
      inFlight = null
    }
  })
  inFlight = { generation, promise }
  return promise
}

async function runRebuild(generation: number): Promise<void> {
  const operation = startOperation('Rebuilding search index')
  const skippedNotes: string[] = []
  try {
    await rebuildIndex({
      generation,
      onSkippedNote: (note) => {
        // The status toast lingers only briefly and samples the first few, so
        // log every skip in full — this is the durable record of which notes
        // fell out of the index and why.
        console.warn(`Index rebuild skipped ${note.path}: ${note.message}`)
        skippedNotes.push(`${note.path}: ${note.message}`)
      },
    })
    if (skippedNotes.length === 0) {
      operation.done()
    } else {
      const sample = skippedNotes.slice(0, 3).join('; ')
      const suffix = skippedNotes.length > 3 ? `; +${skippedNotes.length - 3} more` : ''
      operation.warn(`Rebuilt with ${skippedNotes.length} skipped note(s): ${sample}${suffix}`)
    }
  } catch (cause) {
    operation.fail(errorMessage(cause))
    return
  }
  // A manual rebuild bypasses the watcher pipeline (whose onApplied refreshes
  // the caches), so cached note lists, backlinks, and tags would otherwise
  // show pre-rebuild rows until some unrelated change invalidated them.
  invalidateIndexQueries()
  // index_clear wiped the embedding tables with everything else — rebuild
  // them too, or semantic search stays silently empty until some other
  // trigger re-embeds.
  const embed = await embedStatus()
  if (embed.status === 'ready') {
    await backfillEmbeddingsVisibly({ generation, modelId: embed.model })
  }
}
