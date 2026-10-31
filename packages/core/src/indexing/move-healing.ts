import type { NoteFileService } from '../graph/note-file-service.ts'
import { parseNote } from '../markdown/index.ts'
import type { IndexQueryService } from './index-query-service.ts'
import { pairMovesById, type DetectedMove } from './move-detection.ts'

/**
 * External-move detection (Plan 17), shared by the open-time reconcile
 * (`indexer.ts`) and the live watcher batch (`live.ts`). Both observe the
 * same shape after a rename Reflect didn't perform: an indexed row whose file
 * vanished (an **orphan**) and an unindexed file that appeared (an
 * **arrival**). When an arrival carries an orphan's frontmatter id, the pair
 * is a move — the caller migrates the rows instead of delete+create, so
 * embedding vectors survive (re-embedding identical content costs the user
 * BYOK money).
 *
 * Detection is best-effort by contract: callers treat a thrown error or a
 * missed pair as "no move detected" and fall back to plain delete+create,
 * which always converges. The healing flow end-to-end (including how the
 * desktop layer carries open sessions and routes along) is documented in
 * `docs/readable-filenames.md`.
 */

/**
 * What {@link MoveHealing.detectExternalMoves} found.
 */
export interface ExternalMoveScan {
  /**
   * Orphan→arrival pairs whose frontmatter ids matched unambiguously.
   */
  moves: DetectedMove[]
  /**
   * Arrival content read while pairing, keyed by path — handed back so the
   * caller's indexing pass doesn't read the same files twice.
   */
  content: Map<string, string>
}

export interface MoveHealingDeps {
  readonly noteFile: NoteFileService
  readonly indexQuery: IndexQueryService
}

/**
 * Pairs vanished index rows with arrived files by frontmatter id.
 */
export interface MoveHealing {
  /**
   * Pair orphaned index rows with arrived files by frontmatter id. An
   * unreadable arrival simply can't pair (the caller's plain path retries the
   * read); an ambiguous id never pairs (see {@link pairMovesById}). An abort
   * mid-scan returns no moves: the caller is about to bail anyway. Arrivals
   * are read at the file generation `fileGeneration`.
   */
  detectExternalMoves(
    orphanPaths: string[],
    arrivalPaths: string[],
    fileGeneration: number,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ExternalMoveScan>
}

class MoveHealingImpl implements MoveHealing {
  readonly #deps: MoveHealingDeps

  constructor(deps: MoveHealingDeps) {
    this.#deps = deps
  }

  async detectExternalMoves(
    orphanPaths: string[],
    arrivalPaths: string[],
    fileGeneration: number,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ExternalMoveScan> {
    const { noteFile, indexQuery } = this.#deps
    const content = new Map<string, string>()
    if (orphanPaths.length === 0 || arrivalPaths.length === 0) {
      return { moves: [], content }
    }
    const orphanIds = await indexQuery.getNoteIdsByPath(orphanPaths)
    const arrivalIds = new Map<string, string | null>()
    for (const path of arrivalPaths) {
      if (options?.signal?.aborted) {
        return { moves: [], content }
      }
      try {
        const source = await noteFile.read(path, fileGeneration)
        content.set(path, source)
        const parsed = parseNote({ path, source })
        arrivalIds.set(path, parsed.frontmatter.id ?? null)
      } catch {
        // Unreadable arrival: it can't pair; the caller's plain path retries.
      }
    }
    return { moves: pairMovesById(orphanIds, arrivalIds), content }
  }
}

export function createMoveHealing(deps: MoveHealingDeps): MoveHealing {
  return new MoveHealingImpl(deps)
}
