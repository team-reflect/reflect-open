import type {
  ClockService,
  GraphSessionService,
  IpcBridgeService,
  LoggerService,
  NoteListService,
  VisitedNote,
} from '@reflect/core'
import type { NavigationService } from './navigation-service.ts'

/**
 * The notes this device opened (the index's `note_visits` table). Every
 * arrival on a note route records a visit.
 */
export interface NoteVisitService {
  /**
   * The notes opened most recently first, at most `limit`, without the note
   * on screen.
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
  #entryId: number
  #arrivalSeq: number

  constructor(deps: NoteVisitServiceDeps) {
    this.#deps = deps
    const { entryId, arrivalSeq } = deps.navigation.get()
    this.#entryId = entryId
    this.#arrivalSeq = arrivalSeq
    deps.navigation.subscribe(() => this.#onNavigation())
  }

  async listRecent(limit: number): Promise<VisitedNote[]> {
    const { navigation, noteList } = this.#deps
    const notes = await noteList.listVisitedNotes(limit + 1)
    const route = navigation.get().route
    const current = route.kind === 'note' ? route.path : null
    return notes.filter((note) => note.path !== current).slice(0, limit)
  }

  #onNavigation(): void {
    const { route, entryId, arrivalSeq } = this.#deps.navigation.get()
    // A rename rewrites the route in place; only an arrival is a visit.
    if (entryId === this.#entryId && arrivalSeq === this.#arrivalSeq) {
      return
    }
    this.#entryId = entryId
    this.#arrivalSeq = arrivalSeq
    const generation = this.#deps.graphSession.get().indexGeneration
    if (route.kind === 'note' && generation !== null) {
      void this.#record(route.path, generation)
    }
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
