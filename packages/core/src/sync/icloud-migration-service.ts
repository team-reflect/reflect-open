import type { MaybePromise } from '@reflect/utils'
import type { GraphSessionSource } from '../graph/graph-session.ts'
import { errorMessage } from '../errors.ts'
import type { ICloudNativeService } from '../ipc/icloud-native-service.ts'

/**
 * One move of the open graph into iCloud Drive.
 */
export interface MoveGraphToICloudOptions {
  /**
   * `GitSyncService.disconnectGraph` of the open graph when its backup is
   * connected, else `null`.
   */
  disconnectGitSync: (() => MaybePromise<void>) | null
  /**
   * Reopen the graph at its new root (`GraphSessionService.openRecent`);
   * resolves `false` when it could not be opened.
   */
  openGraph: (root: string) => MaybePromise<boolean>
  /**
   * Called once the copy landed and the backup step ran, right before the
   * graph reopens, with the failure text so far (`null` when there is none).
   */
  onCopied?: (failure: string | null) => void
}

/**
 * The services an {@link ICloudMigrationService} runs on.
 */
export interface ICloudMigrationServiceDeps {
  readonly icloudNative: ICloudNativeService
  readonly graphSession: GraphSessionSource
}

/**
 * Moves a local graph into the iCloud Drive container (Plan 21 Phase 1, the
 * desktop leg). The move copies (count+byte verified), then disconnects the
 * old folder's Git backup remote before reopening the graph at its iCloud
 * home. Ordered copy-first so a failed copy leaves everything — including the
 * backup — exactly as it was; the original folder stays on disk untouched as
 * the recovery copy either way.
 */
export interface ICloudMigrationService {
  /**
   * Run the move of the open graph, pinned to its generation. Never rejects:
   * resolves with the text of what went wrong for the user, or `null` when
   * every step worked.
   */
  moveGraph(options: MoveGraphToICloudOptions): Promise<string | null>
}

class ICloudMigrationServiceImpl implements ICloudMigrationService {
  readonly #deps: ICloudMigrationServiceDeps

  constructor(deps: ICloudMigrationServiceDeps) {
    this.#deps = deps
  }

  async moveGraph({
    disconnectGitSync,
    openGraph,
    onCopied,
  }: MoveGraphToICloudOptions): Promise<string | null> {
    const { icloudNative, graphSession } = this.#deps
    const { session } = graphSession.getState()
    if (session === null) {
      return 'No graph is open.'
    }
    let failure: string | null = null
    try {
      // Copy first: if it fails, nothing changed — the backup is still
      // connected and the graph untouched.
      const newRoot = await icloudNative.adoptGraph(session.generation)
      if (disconnectGitSync !== null) {
        try {
          await disconnectGitSync()
        } catch (caught) {
          // The iCloud copy has no .git, so exclusivity holds for the new
          // graph regardless; the original folder keeping its backup is the
          // recovery copy working as intended. Tell the user, don't block.
          failure = `The graph moved to iCloud, but GitHub sync could not be disconnected from the original folder: ${errorMessage(caught)}`
        }
      }
      onCopied?.(failure)
      const opened = await openGraph(newRoot)
      if (!opened) {
        // Append rather than replace: a disconnect failure above must stay
        // visible alongside this one — both tell the user something distinct.
        failure = [
          failure,
          'The copy landed in iCloud but could not be opened — open it from Saved graphs.',
        ]
          .filter(Boolean)
          .join(' ')
      }
      return failure
    } catch (caught) {
      return errorMessage(caught)
    }
  }
}

export function createICloudMigrationService(
  deps: ICloudMigrationServiceDeps,
): ICloudMigrationService {
  return new ICloudMigrationServiceImpl(deps)
}
