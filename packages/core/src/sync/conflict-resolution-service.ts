import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import { errorMessage } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import {
  conflictMarkerBlockCount,
  conflictMarkerLabels,
  resolveConflictMarkers,
  type ConflictMarkerLabels,
  type ConflictResolution,
} from '../markdown/conflict-markers.ts'

/**
 * What one {@link ConflictResolutionService.resolve} did.
 */
export interface ConflictResolutionOutcome {
  /**
   * Whether the resolved file reached disk. True even when the reindex step
   * failed afterwards; index-backed views must refresh whenever it is true.
   */
  wrote: boolean
  /**
   * The failure text for the user, or `null` when every step worked.
   */
  error: string | null
}

/**
 * What {@link ConflictResolutionService.conflictMarkers} found in a file.
 */
export interface ConflictMarkers {
  /**
   * The device labels of the first marker block, or `null` when it has none.
   */
  labels: ConflictMarkerLabels | null
  /**
   * How many marker blocks the file holds.
   */
  blocks: number
}

/**
 * The services a {@link ConflictResolutionService} runs on.
 */
export interface ConflictResolutionServiceDeps {
  readonly noteFile: NoteFileService
  readonly indexLifecycle: IndexLifecycleService
  readonly fileChanges: FileChangeService
  readonly graphSession: GraphSessionSource
}

/**
 * Resolution of conflict markers for one note, as raw-text surgery. It serves
 * notes that an older version left with markers. Steps:
 * read the file, splice the kept side(s) (`resolveConflictMarkers` — markers
 * don't survive the editor round-trip, so the editor can't do this), write it
 * back, reindex, and notify open sessions. The conflict flag is a projection
 * of the file content, so consumers (the notice banner) clear themselves once
 * the resolved file reindexes.
 */
export interface ConflictResolutionService {
  /**
   * Splice the chosen side(s) into the file of the open graph, reindex it
   * (unless its index failed to open), and notify open sessions. Never
   * rejects; does nothing when no graph is open.
   */
  resolve(path: string, keep: ConflictResolution): Promise<ConflictResolutionOutcome>
  /**
   * The conflict markers of the note's file on disk, never of an open
   * session's buffer. Rejects when no graph is open.
   */
  conflictMarkers(path: string): Promise<ConflictMarkers>
}

class ConflictResolutionServiceImpl implements ConflictResolutionService {
  readonly #deps: ConflictResolutionServiceDeps

  constructor(deps: ConflictResolutionServiceDeps) {
    this.#deps = deps
  }

  async conflictMarkers(path: string): Promise<ConflictMarkers> {
    const { noteFile, graphSession } = this.#deps
    const session = requireGraphSession(graphSession)
    const source = await noteFile.read(path, session.generation)
    return { labels: conflictMarkerLabels(source), blocks: conflictMarkerBlockCount(source) }
  }

  async resolve(path: string, keep: ConflictResolution): Promise<ConflictResolutionOutcome> {
    const { noteFile, indexLifecycle, fileChanges, graphSession } = this.#deps
    const { session } = graphSession.getState()
    if (session === null) {
      return { wrote: false, error: null }
    }
    const { generation, indexGeneration } = session
    let wrote = false
    let error: string | null = null
    try {
      const source = await noteFile.read(path, generation)
      const resolved = resolveConflictMarkers(source, keep)
      await noteFile.write(path, resolved, generation)
      wrote = true
      if (indexGeneration !== null) {
        await indexLifecycle.indexNote(path, {
          generation: indexGeneration,
          fileGeneration: generation,
          content: resolved,
        })
      }
    } catch (caught: unknown) {
      error = errorMessage(caught)
    } finally {
      if (wrote) {
        // The file changed on disk even if the reindex step failed (the
        // watcher will redo that) — reload the open (protected) session,
        // which round-trips again now and reopens editable.
        fileChanges.emit({ changes: [{ path, kind: 'upsert' }], source: 'own-write' })
      }
    }
    return { wrote, error }
  }
}

export function createConflictResolutionService(
  deps: ConflictResolutionServiceDeps,
): ConflictResolutionService {
  return new ConflictResolutionServiceImpl(deps)
}
