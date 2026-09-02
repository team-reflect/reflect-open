import { writeNote } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { hashContent } from '../indexing/hash'
import { upsertFrontmatter } from '../markdown/frontmatter'
import { readPendingCaptureSnapshot, type PendingCaptureSnapshot } from './capture-enrichment-write'
import type { CaptureIdentity } from './capture-identity'
import { notePrivate, noteSource } from './capture-note'

/**
 * What every enrichment leg (link, post) needs from the pass that runs it:
 * the graph generation, the abort gate, and the privacy re-check that must
 * follow every slow await. The pass builds one context and hands it to each
 * leg, so the gate is implemented once.
 */
export interface EnrichmentContext {
  generation: number
  /** Abort gate — the graph session ended. */
  stale: () => boolean
  /**
   * Re-read the note and its daily. Returns `null` — after marking the
   * capture skipped — when the note was edited (hash mismatch), either note
   * went private, or the capture already moved on.
   */
  currentCapture: (
    identity: CaptureIdentity,
    expectedHash?: string,
  ) => Promise<PendingCaptureSnapshot | null>
  /** Mark a still-pending capture skipped. */
  skipPending: (identity: CaptureIdentity) => Promise<void>
}

/** How one leg ended for one capture. */
export type EnrichmentResult =
  | 'enriched'
  | 'skipped'
  | 'stale'
  /** A provider is configured but its key is unavailable; left pending. */
  | 'waiting-for-key'

export interface CreateEnrichmentContextInput {
  generation: number
  isStale?: (() => boolean) | undefined
  /** Observes every capture marked skipped, for the pass's counts. */
  onSkipped: () => void
}

export function createEnrichmentContext(input: CreateEnrichmentContextInput): EnrichmentContext {
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
    input.onSkipped()
  }
  return {
    generation: input.generation,
    stale: () => input.isStale?.() === true,
    skipPending: async (identity) => {
      const snapshot = await readPendingCaptureSnapshot(identity, input.generation)
      if (snapshot !== null) {
        await markSkipped(snapshot.source, identity)
      }
    },
    currentCapture: async (identity, expectedHash) => {
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
    },
  }
}
