import type {
  ClockService,
  GraphSessionService,
  IpcBridgeService,
  LoggerService,
  NoteListService,
  Unlisten,
  VisitedNote,
} from '@reflect/core'
import type { NavigationService } from './navigation-service.ts'

/**
 * The notes this device opened (the index's `note_visits` table).
 */
export interface NoteVisitService {
  /**
   * Record the note on screen, then every later arrival on a note route,
   * until the returned function runs. A router calls it once for each fresh
   * history, because `NavigationService.reset` notifies no subscriber.
   */
  track(): Unlisten
  /**
   * The notes opened most recently first, at most `limit`. Daily notes and
   * templates are left out.
   */
  listRecent(limit: number): Promise<VisitedNote[]>
}

export interface NoteVisitServiceDeps {
  readonly navigation: NavigationService
  readonly graphSession: GraphSessionService
  readonly ipc: IpcBridgeService
  readonly noteList: Pick<NoteListService, 'listVisitedNotes'>
  readonly clock: ClockService
  readonly logger: LoggerService
}

class NoteVisitServiceImpl implements NoteVisitService {
  readonly #deps: NoteVisitServiceDeps

  constructor(deps: NoteVisitServiceDeps) {
    this.#deps = deps
  }

  track(): Unlisten {
    const { navigation, graphSession } = this.#deps
    let seen: { entryId: number; arrivalSeq: number } | null = null
    const check = (): void => {
      const { route, entryId, arrivalSeq } = navigation.get()
      // A rename rewrites the route in place; only an arrival is a visit.
      if (seen?.entryId === entryId && seen.arrivalSeq === arrivalSeq) {
        return
      }
      // Without an index, the arrival stays unseen until the index opens.
      const generation = graphSession.get().indexGeneration
      if (generation === null) {
        return
      }
      seen = { entryId, arrivalSeq }
      if (route.kind === 'note') {
        void this.#record(route.path, generation)
      }
    }
    check()
    const unlistenNavigation = navigation.subscribe(check)
    const unlistenGraph = graphSession.subscribe(check)
    return () => {
      unlistenNavigation()
      unlistenGraph()
    }
  }

  async listRecent(limit: number): Promise<VisitedNote[]> {
    return await this.#deps.noteList.listVisitedNotes(limit)
  }

  async #record(path: string, generation: number): Promise<void> {
    const { ipc, clock, logger } = this.#deps
    try {
      await ipc.call('note_visit_record', { path, visitedMs: clock.now(), generation })
    } catch (error) {
      logger.warn('recording a note visit failed', error)
    }
  }
}

export function createNoteVisitService(deps: NoteVisitServiceDeps): NoteVisitService {
  return new NoteVisitServiceImpl(deps)
}
