import { isIsoDate } from '@reflect/utils'
import {
  requireGraphSession,
  type GraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import type { IdService } from '../ports/id-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { PathService } from '../ports/path-service.ts'
import { errorMessage } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dateFromDailyPath, isDaily } from '../graph/paths.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { IndexQueryService, PinnedNote } from '../indexing/index-query-service.ts'
import { parseNote } from '../markdown/extract.ts'
import { dailyDeepLink, noteDeepLink } from '../navigation/deep-link-format.ts'
import { isPinned } from '../markdown/model.ts'
import type { NoteDocumentService } from './note-document-service.ts'
import {
  applyPinnedNoteOverlays,
  type NoteRowOverlayPatch,
  type NoteRowService,
} from './note-row-service.ts'
import type { OpenDocumentsService } from './open-documents-service.ts'
import { getNextPinOrder, isValidPinOrder } from './pin-order.ts'

/**
 * How a deduped, self-reporting note action ended:
 *
 * - `done`: the note was written; the result carries what the note now holds.
 * - `failed`: the action failed and reported the error through operations.
 */
export type NoteActionOutcome<Result> =
  | ({ readonly status: 'done' } & Result)
  | { readonly status: 'failed' }

/**

 * What a pin action left in the note's frontmatter.

 */
export interface NotePinResult {
  readonly pinned: boolean
  /**
   * The written shelf order; `null` for an unpinned note and for a bare `pinned: true`.
   */
  readonly pinOrder: number | null
}

/**

 * One pin order that {@link NoteActionsService.reorderPinned} wrote.

 */
export interface NotePinOrderWrite {
  readonly path: string
  readonly pinOrder: number
}

export interface NoteTrashFailure {
  readonly path: string
  readonly cause: unknown
}

/**

 * Which notes went to the trash and which could not, each in request order.

 */
export interface NoteTrashResult {
  readonly succeeded: readonly string[]
  readonly failed: readonly NoteTrashFailure[]
}

/**
 * Whether a note may be moved to the trash. Daily notes are the app's
 * chronological spine and cannot be deleted.
 */
export function canTrashNote(path: string): boolean {
  return !isDaily(path)
}

/**
 * The user's actions on one note that are not edits: pin, private, trash,
 * copy deep link, copy path. Markdown owns the final state; pin, private, and
 * trash record what they write in the note-row overlay ({@link NoteRowService})
 * so every reader shows it before the index catches up, and a failure drops
 * that overlay again.
 */
export interface NoteActionsService {
  /**
   * Toggle the pin from the state the note's frontmatter holds now. A pin
   * takes the shelf order after the highest on the shelf (index rows merged
   * with the overlay), or a bare `pinned: true` when the shelf cannot be read.
   * Deduped with {@link NoteActionsService.unpin} per generation and path: a
   * second call while one is in flight returns the first call's result. A
   * failure is reported as an "Updating pin" operation; with no graph open it
   * fails without a report.
   */
  togglePinned(path: string): Promise<NoteActionOutcome<NotePinResult>>
  /**
   * Remove a pin directionally, without reading the current pin state.
   */
  unpin(path: string): Promise<NoteActionOutcome<NotePinResult>>
  /**
   * Write the shelf order of each note that carries a valid one, and return
   * the orders written. Calls write one after another, in call order. Rejects
   * when a write fails. Writes nothing when no graph is open.
   */
  reorderPinned(
    notes: ReadonlyArray<Pick<PinnedNote, 'path' | 'pinnedOrder'>>,
  ): Promise<NotePinOrderWrite[]>
  /**
   * Toggle `private` from the state the note's frontmatter holds now. Deduped
   * per generation and path like {@link NoteActionsService.togglePinned}; a
   * failure is reported as an "Updating privacy" operation.
   */
  togglePrivate(path: string): Promise<NoteActionOutcome<{ readonly isPrivate: boolean }>>
  /**
   * Whether `path` may be moved to the trash; see {@link canTrashNote}.
   */
  canTrash(path: string): boolean
  /**
   * Delete a regular note and detach its editor session without flushing.
   *
   * The file goes to the trash: the OS-native trash on desktop, the
   * graph-local `.reflect/trash/` on mobile (which has no OS trash). It is
   * recoverable either way, and sync-ignored. Once it is in the trash, the
   * note-row overlay marks it `trashed` until the index drops it (the desktop
   * watcher's reindex, or the mobile write echo). Daily notes are
   * intentionally blocked.
   *
   * The session first pauses persistence and settles its initial load plus any
   * write already in flight. A lazy-created note that still has no backing file
   * is deleted by discarding that session alone. Otherwise delete first, discard
   * second. If the filesystem delete fails, persistence resumes so the mounted
   * editor remains intact. Only once the file is in trash do we discard the
   * session; otherwise a normal teardown flush could recreate the deleted file.
   *
   * Never rejects and reports nothing: a failure comes back in `failed`.
   */
  trash(path: string): Promise<NoteTrashResult>
  /**
   * {@link NoteActionsService.trash}, rejecting with the cause when the note could not be trashed.
   */
  trashOne(path: string): Promise<void>
  /**
   * {@link NoteActionsService.trash} for each path in order, under one
   * "Trashing notes" operation. A failure is recorded, not rethrown
   * mid-batch, so the remaining notes still trash; the operation then fails
   * with the last error, or with `No graph is open.` when none is.
   */
  trashMany(paths: readonly string[]): Promise<NoteTrashResult>
  /**
   * The most durable deep link the note can have. A daily note is addressed
   * by its date. A regular note is addressed by its frontmatter `id`, minted
   * here on first use for notes that predate Plan 17's ids or were created
   * outside Reflect, so the link survives every rename; the id lands through
   * the session-or-disk frontmatter channel like pin and private do.
   */
  deepLinkFor(path: string): Promise<string>
  /**
   * Resolve the graph-relative `path` against the open graph's root to an
   * absolute filesystem path for use in tools outside Reflect (agent chats,
   * editors, terminals). Joining through the host preserves the host
   * platform's path syntax. Rejects when no graph is open.
   */
  absolutePathFor(path: string): Promise<string>
}

export interface NoteActionsServiceDeps {
  readonly noteDocuments: NoteDocumentService
  readonly noteFile: NoteFileService
  readonly openDocuments: OpenDocumentsService
  readonly indexLifecycle: IndexLifecycleService
  readonly indexQuery: IndexQueryService
  readonly noteRows: NoteRowService
  readonly progress: ProgressPort
  readonly path: PathService
  readonly id: IdService
  readonly graphSession: GraphSessionSource
}

/**
 * The pin and privacy toggles' outcome with no graph open: failed, with nothing to report.
 */
const NO_GRAPH: { readonly status: 'failed' } = { status: 'failed' }

class NoteActionsServiceImpl implements NoteActionsService {
  readonly #deps: NoteActionsServiceDeps
  readonly #pendingPins = new Map<string, Promise<NoteActionOutcome<NotePinResult>>>()
  readonly #pendingPrivacy = new Map<
    string,
    Promise<NoteActionOutcome<{ readonly isPrivate: boolean }>>
  >()
  #reorderChain: Promise<unknown> = Promise.resolve()

  constructor(deps: NoteActionsServiceDeps) {
    this.#deps = deps
  }

  async togglePinned(path: string): Promise<NoteActionOutcome<NotePinResult>> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return NO_GRAPH
    }
    const { generation } = session
    return await this.#dedupe(this.#pendingPins, path, generation, () => {
      return this.#updatePin(path, generation, 'toggle')
    })
  }

  async unpin(path: string): Promise<NoteActionOutcome<NotePinResult>> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return NO_GRAPH
    }
    const { generation } = session
    return await this.#dedupe(this.#pendingPins, path, generation, () => {
      return this.#updatePin(path, generation, 'unpin')
    })
  }

  async reorderPinned(
    notes: ReadonlyArray<Pick<PinnedNote, 'path' | 'pinnedOrder'>>,
  ): Promise<NotePinOrderWrite[]> {
    const { noteRows, graphSession } = this.#deps
    const session = graphSession.getState().session
    if (session === null) {
      return []
    }
    const { generation } = session
    const writes: NotePinOrderWrite[] = []
    for (const note of notes) {
      const order = note.pinnedOrder
      if (isValidPinOrder(order)) {
        writes.push({ path: note.path, pinOrder: order })
        noteRows.setOverlay(note.path, generation, { pinnedOrder: order })
      }
    }
    // The overlay shows every reorder at once; the writes land in call order.
    const run = this.#reorderChain.then(() => this.#writePinOrders(writes, generation))
    this.#reorderChain = run.catch(() => undefined)
    return await run
  }

  async togglePrivate(path: string): Promise<NoteActionOutcome<{ readonly isPrivate: boolean }>> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return NO_GRAPH
    }
    const { generation } = session
    return await this.#dedupe(this.#pendingPrivacy, path, generation, () => {
      return this.#togglePrivate(path, generation)
    })
  }

  canTrash(path: string): boolean {
    return canTrashNote(path)
  }

  async trash(path: string): Promise<NoteTrashResult> {
    try {
      await this.#trashOne(path, requireGraphSession(this.#deps.graphSession).generation)
      return { succeeded: [path], failed: [] }
    } catch (cause) {
      return { succeeded: [], failed: [{ path, cause }] }
    }
  }

  async trashOne(path: string): Promise<void> {
    await this.#trashOne(path, requireGraphSession(this.#deps.graphSession).generation)
  }

  async trashMany(paths: readonly string[]): Promise<NoteTrashResult> {
    const { progress, graphSession } = this.#deps
    const succeeded: string[] = []
    const failed: NoteTrashFailure[] = []
    if (paths.length === 0) {
      return { succeeded, failed }
    }
    let session: GraphSession
    try {
      session = requireGraphSession(graphSession)
    } catch (cause) {
      progress.fail('Trashing notes', errorMessage(cause))
      return { succeeded, failed: paths.map((path) => ({ path, cause })) }
    }
    const operation = progress.start('Trashing notes')
    operation.progress(0, paths.length)
    let attempted = 0
    for (const path of paths) {
      try {
        await this.#trashOne(path, session.generation)
        succeeded.push(path)
      } catch (cause) {
        failed.push({ path, cause })
      }
      attempted += 1
      operation.progress(attempted, paths.length)
    }
    const last = failed.at(-1)
    if (last === undefined) {
      operation.done()
    } else {
      operation.fail(errorMessage(last.cause))
    }
    return { succeeded, failed }
  }

  async deepLinkFor(path: string): Promise<string> {
    return await this.#deepLinkFor(path, requireGraphSession(this.#deps.graphSession))
  }

  async absolutePathFor(path: string): Promise<string> {
    const session = requireGraphSession(this.#deps.graphSession)
    return await this.#deps.path.join(session.root, path)
  }

  /**
   * Run `action` once per key at a time; a call while it runs gets the same promise.
   */
  #dedupe<Result>(
    pending: Map<string, Promise<Result>>,
    path: string,
    generation: number,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const key = JSON.stringify([generation, path])
    const inFlight = pending.get(key)
    if (inFlight !== undefined) {
      return inFlight
    }
    const run = action().finally(() => {
      pending.delete(key)
    })
    pending.set(key, run)
    return run
  }

  /**
   * The pinned notes the index lists, or `null` when the index cannot say.
   */
  async #readIndexedShelf(): Promise<PinnedNote[] | null> {
    const { indexQuery } = this.#deps
    try {
      return await indexQuery.getPinnedNotes()
    } catch {
      return null
    }
  }

  /**
   * The privacy readers show for `path` now; `false` when the index cannot say.
   */
  async #readPrivacy(path: string, generation: number): Promise<boolean> {
    const { noteRows, indexQuery } = this.#deps
    const overlaid = noteRows.getOverlaysOn(generation).get(path)?.isPrivate
    if (overlaid !== undefined) {
      return overlaid
    }
    try {
      return (await indexQuery.getNote(path))?.isPrivate ?? false
    } catch {
      return false
    }
  }

  #pinOverlay(pinned: boolean, order: number | null): NoteRowOverlayPatch {
    return pinned ? { isPinned: true, pinnedOrder: order } : { isPinned: false }
  }

  async #updatePin(
    path: string,
    generation: number,
    kind: 'toggle' | 'unpin',
  ): Promise<NoteActionOutcome<NotePinResult>> {
    const { noteRows, noteDocuments, progress } = this.#deps
    let written: NoteRowOverlayPatch | null = null
    try {
      // Predict from what readers show now, so the overlay lands before the note is read.
      let order: number | null = null
      let predicted = false
      if (kind === 'toggle') {
        const indexed = await this.#readIndexedShelf()
        // Merged with the overlay after the await, so a concurrent pin's order counts.
        const shelf =
          indexed === null
            ? null
            : applyPinnedNoteOverlays(indexed, noteRows.getOverlaysOn(generation), (notePath) => ({
                path: notePath,
                title: '',
                dailyDate: null,
                pinnedOrder: null,
              }))
        // A shelf the index cannot read can't say what the next order is. A
        // bare `pinned: true` still pins; the note sorts last until a reorder numbers it.
        order = shelf === null ? null : getNextPinOrder(shelf)
        predicted = shelf?.some((note) => note.path === path) !== true
      }
      written = this.#pinOverlay(predicted, order)
      noteRows.setOverlay(path, generation, written)
      const pinned =
        kind === 'unpin'
          ? false
          : !isPinned(parseNote({ path, source: await noteDocuments.readSource(path) }).frontmatter)
      const pinOrder = pinned ? order : null
      if (pinned !== predicted) {
        written = this.#pinOverlay(pinned, order)
        noteRows.setOverlay(path, generation, written)
      }
      await noteDocuments.commitFrontmatter(
        path,
        { pinned: pinned ? (pinOrder ?? true) : false },
        generation,
      )
      return { status: 'done', pinned, pinOrder }
    } catch (cause) {
      if (written !== null) {
        noteRows.dropOverlay(path, generation, written)
      }
      progress.fail('Updating pin', errorMessage(cause))
      return { status: 'failed' }
    }
  }

  async #togglePrivate(
    path: string,
    generation: number,
  ): Promise<NoteActionOutcome<{ isPrivate: boolean }>> {
    const { noteRows, noteDocuments, progress } = this.#deps
    let written: NoteRowOverlayPatch | null = null
    try {
      const predicted = !(await this.#readPrivacy(path, generation))
      written = { isPrivate: predicted }
      noteRows.setOverlay(path, generation, written)
      const source = await noteDocuments.readSource(path)
      const isPrivate = !parseNote({ path, source }).frontmatter.private
      if (isPrivate !== predicted) {
        written = { isPrivate }
        noteRows.setOverlay(path, generation, written)
      }
      await noteDocuments.commitFrontmatter(path, { private: isPrivate }, generation)
      return { status: 'done', isPrivate }
    } catch (cause) {
      if (written !== null) {
        noteRows.dropOverlay(path, generation, written)
      }
      progress.fail('Updating privacy', errorMessage(cause))
      return { status: 'failed' }
    }
  }

  async #writePinOrders(
    writes: readonly NotePinOrderWrite[],
    generation: number,
  ): Promise<NotePinOrderWrite[]> {
    const { noteRows, noteDocuments } = this.#deps
    try {
      await Promise.all(
        writes.map(async (write) => {
          await noteDocuments.commitFrontmatter(write.path, { pinned: write.pinOrder }, generation)
        }),
      )
      return [...writes]
    } catch (cause) {
      for (const write of writes) {
        noteRows.dropOverlay(write.path, generation, { pinnedOrder: write.pinOrder })
      }
      throw cause
    }
  }

  async #trashOne(path: string, generation: number): Promise<void> {
    const { noteFile, openDocuments, noteRows } = this.#deps
    if (!canTrashNote(path)) {
      throw new Error('Daily notes cannot be deleted')
    }
    const session = openDocuments.sessionFor(path)
    const unpersisted = await session?.prepareDelete()
    if (session !== null && unpersisted === true) {
      noteRows.setOverlay(path, generation, { trashed: true })
      session.discard()
      return
    }
    try {
      await noteFile.delete(path, generation)
    } catch (cause) {
      session?.cancelDelete()
      throw cause
    }
    // Marked only once the file is gone: a note that fails stays listed.
    noteRows.setOverlay(path, generation, { trashed: true })
    session?.discard()
    const currentSession = openDocuments.sessionFor(path)
    if (currentSession !== session) {
      currentSession?.discard()
    }
  }

  async #deepLinkFor(path: string, session: GraphSession): Promise<string> {
    const { noteDocuments, id, indexLifecycle } = this.#deps
    if (isDaily(path)) {
      const date = dateFromDailyPath(path)
      // Calendar-validated like the router: a daily/ file with an impossible
      // date (2026-02-31) routes as a plain note everywhere else, so it gets a
      // note address too: a date form would be a link the parser rejects.
      if (date !== null && isIsoDate(date)) {
        return dailyDeepLink(date)
      }
    }
    const source = await noteDocuments.readSource(path)
    // A blank `id:` counts as no id (same rule as the CLI's `reflect open`):
    // linking it would emit `reflect://note/`, which the parser rejects.
    const existing = parseNote({ path, source }).frontmatter.id
    if (existing !== undefined && existing.trim() !== '') {
      return noteDeepLink(existing)
    }
    const minted = id.noteId()
    await noteDocuments.commitFrontmatter(path, { id: minted }, session.generation)
    // Resolution reads the index, which trails local writes by a watcher
    // debounce: index the mint now so the copied link resolves immediately.
    // Best-effort: the watcher pass covers this on its own schedule anyway.
    if (session.indexGeneration !== null) {
      try {
        await indexLifecycle.indexNote(path, {
          generation: session.indexGeneration,
          fileGeneration: session.generation,
        })
      } catch {
        // the copied link still works once the watcher reindexes the note
      }
    }
    return noteDeepLink(minted)
  }
}

export function createNoteActionsService(deps: NoteActionsServiceDeps): NoteActionsService {
  return new NoteActionsServiceImpl(deps)
}
