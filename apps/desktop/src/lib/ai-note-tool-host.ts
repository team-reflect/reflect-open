import { diffLines } from 'diff'
import {
  chatNoteChangesForTurn,
  createNoteWithTitlePrepared,
  detectConflictMarkers,
  errorMessage,
  hashContent,
  isAppError,
  isNotePath,
  isTemplatePath,
  parseNote,
  PreparedNoteCreationRefusal,
  pendingChatNoteChanges,
  prepareChatNoteChange,
  readNote,
  readNoteForAi,
  setChatNoteChangeState,
  setChatNoteChangesStateBatch,
  splitFrontmatter,
  trashNoteIfRevision,
  writeNoteIfRevision,
  type ApplyChatNoteChangeInput,
  type ChatNoteChange,
  type ChatNoteChangeState,
  type ChatNoteToolHost,
  type CreateChatNoteInput,
  type NoteMutationOutput,
  type NoteAiReadOutcome,
  type NoteRevisionTrashOutcome,
  type NoteRevisionWriteOutcome,
  type PrepareChatNoteChangeInput,
  type PreparedNoteCreation,
  type SetChatNoteChangeStateResult,
  type SetChatNoteChangesStateBatchResult,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import type { NoteBodyMutationResult, NoteFreshContent, NoteSession } from '@/editor/note-session'
import { checkRoundTrip } from '@/editor/roundtrip'
import {
  createNotePathOperationQueue,
  routeNoteOperation,
  type NotePathOperationQueue,
} from './note-mutation-routing'

interface DesktopChatNoteHostDependencies {
  readonly lookupSession: (path: string) => NoteSession | null
  readonly readNote: (path: string, generation: number) => Promise<string>
  readonly readNoteForAi: (
    path: string,
    generation: number,
    requesterOwnerId?: string,
  ) => Promise<NoteAiReadOutcome>
  readonly writeNoteIfRevision: (
    path: string,
    contents: string,
    expectedRevision: string,
    generation: number,
    requesterOwnerId?: string,
  ) => Promise<NoteRevisionWriteOutcome>
  readonly trashNoteIfRevision: (
    path: string,
    expectedRevision: string,
    generation: number,
    requesterOwnerId?: string,
  ) => Promise<NoteRevisionTrashOutcome>
  readonly createNote: (
    title: string,
    generation: number,
    body: string | undefined,
    onPrepared: (creation: PreparedNoteCreation) => Promise<void>,
  ) => Promise<PreparedNoteCreation>
  readonly prepareChange: (input: {
    change: PrepareChatNoteChangeInput
    generation: number
  }) => Promise<ChatNoteChange>
  readonly setChangeState: (input: {
    id: string
    expectedState: ChatNoteChangeState
    state: ChatNoteChangeState
    errorMessage: string | null
    updatedMs: number
    generation: number
  }) => Promise<SetChatNoteChangeStateResult>
  readonly setChangesStateBatch: (input: {
    ids: string[]
    expectedState: ChatNoteChangeState
    state: ChatNoteChangeState
    errorMessage: string | null
    updatedMs: number
    generation: number
  }) => Promise<SetChatNoteChangesStateBatchResult>
  readonly changesForTurn: (turnId: string, generation: number) => Promise<ChatNoteChange[]>
  readonly pendingChanges: (generation: number) => Promise<ChatNoteChange[]>
  readonly randomId: () => string
  readonly now: () => number
}

const defaultDependencies: DesktopChatNoteHostDependencies = {
  lookupSession: openSession,
  readNote,
  readNoteForAi,
  writeNoteIfRevision,
  trashNoteIfRevision,
  createNote: createNoteWithTitlePrepared,
  prepareChange: prepareChatNoteChange,
  setChangeState: setChatNoteChangeState,
  setChangesStateBatch: setChatNoteChangesStateBatch,
  changesForTurn: chatNoteChangesForTurn,
  pendingChanges: pendingChatNoteChanges,
  randomId: () => crypto.randomUUID(),
  now: Date.now,
}

interface GraphMutationCoordinator {
  readonly queue: NotePathOperationQueue
  readonly active: Set<Promise<unknown>>
}

const graphCoordinators = new Map<string, GraphMutationCoordinator>()

function coordinatorFor(
  graphGeneration: number,
  indexGeneration: number | null,
): GraphMutationCoordinator {
  const key = `${graphGeneration}:${indexGeneration}`
  const existing = graphCoordinators.get(key)
  if (existing !== undefined) {
    return existing
  }
  const created = { queue: createNotePathOperationQueue(), active: new Set<Promise<unknown>>() }
  graphCoordinators.set(key, created)
  return created
}

export interface DesktopChatNoteToolHostOptions {
  readonly conversationId: string
  readonly turnId: string
  readonly graphGeneration: number
  readonly indexGeneration: number | null
  /** Test seam; production callers use the native/core defaults. */
  readonly dependencies?: Partial<DesktopChatNoteHostDependencies> | undefined
}

/** A turn-scoped host whose local operations can outlive provider cancellation. */
export interface DesktopChatNoteToolHost extends ChatNoteToolHost {
  /** Permanently refuse new mutations while allowing already-dispatched work to settle. */
  seal: () => void
  /** Settle all local mutations dispatched through this turn's host. */
  settled: () => Promise<void>
}

class StalePreparedMutationError extends Error {}

class GuardedAiReadError extends Error {
  constructor(readonly kind: 'blocked' | 'missing') {
    super(kind === 'blocked' ? 'note is owned by another live editor' : 'note is missing')
  }
}

const UNDO_UNCERTAIN_PREFIX = 'Undo outcome uncertain: '

/**
 * Bind core chat note tools to the active graph, live editor sessions, and
 * durable change journal. One instance belongs to one chat turn.
 */
export function createDesktopChatNoteToolHost(
  options: DesktopChatNoteToolHostOptions,
): DesktopChatNoteToolHost {
  const dependencies: DesktopChatNoteHostDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  }
  const { queue, active } = coordinatorFor(options.graphGeneration, options.indexGeneration)
  let nextSequence = 0
  let sealed = false

  function track<Result>(operation: Promise<Result>): Promise<Result> {
    active.add(operation)
    void operation.finally(() => active.delete(operation)).catch(() => {})
    return operation
  }

  function sequence(): number {
    const current = nextSequence
    nextSequence += 1
    return current
  }

  async function read(path: string): Promise<string> {
    if (!isNotePath(path)) {
      // Asset-description sidecars are local provenance sources too, but they
      // have no editor session to own. Keep their existing pinned read path.
      return await dependencies.readNote(path, options.graphGeneration)
    }
    return await track(
      queue.run(
        path,
        async () =>
          await routeNoteOperation(
            path,
            {
              open: async (session) => {
                // Reconcile a generation-pinned disk read with the live editor.
                // A dirty buffer plus different disk bytes parks a conflict and
                // returns no source; a clean buffer adopts the disk source. If
                // disk became private, returning that authoritative source lets
                // core's local privacy gate refuse it without publishing the
                // stale public buffer.
                const { fresh, persistedSource } = await readFreshOpenNote(
                  session,
                  path,
                  options.graphGeneration,
                  (readPath, generation) =>
                    guardedAiRead(dependencies, readPath, generation, session.ownerId ?? undefined),
                )
                if (fresh === null) {
                  if (persistedSource !== null && isPrivateSource(path, persistedSource)) {
                    return persistedSource
                  }
                  throw new Error('the open note is not ready')
                }
                return fresh.source
              },
              closed: async () => await guardedAiRead(dependencies, path, options.graphGeneration),
            },
            dependencies.lookupSession,
          ),
      ),
    )
  }

  async function applyChange(input: ApplyChatNoteChangeInput): Promise<NoteMutationOutput> {
    if (sealed) {
      return sealedMutationFailure()
    }
    const changeSequence = sequence()
    return await track(
      queue.run(input.path, async () => {
        const indexGeneration = options.indexGeneration
        if (indexGeneration === null) {
          return failure('unavailable', 'Durable change history is unavailable for this graph.')
        }
        const refusal = validateMutationSources(input.path, input.beforeSource, input.afterSource)
        if (refusal !== null) {
          return refusal
        }

        const changeId = dependencies.randomId()
        let prepared = false
        let journalAttempted = false
        let requesterOwnerId: string | undefined
        const createdMs = dependencies.now()
        const preparedChange: PrepareChatNoteChangeInput = {
          id: changeId,
          conversationId: options.conversationId,
          turnId: options.turnId,
          toolCallId: input.toolCallId,
          path: input.path,
          sequence: changeSequence,
          operation: input.kind,
          beforeSource: input.beforeSource,
          afterSource: input.afterSource,
          beforeRevision: input.expectedRevision,
          afterRevision: await hashContent(input.afterSource),
          createdMs,
        }
        const journal = async (): Promise<void> => {
          journalAttempted = true
          await dependencies.prepareChange({
            change: preparedChange,
            generation: indexGeneration,
          })
          prepared = true
        }

        try {
          const outcome = await routeNoteOperation<
            NoteBodyMutationResult | NoteRevisionWriteOutcome
          >(
            input.path,
            {
              open: async (session) => {
                requesterOwnerId = session.ownerId ?? undefined
                const beforeBody = splitFrontmatter(input.beforeSource).body
                const afterBody = splitFrontmatter(input.afterSource).body
                return await session.commitBodyMutation({
                  expectedRevision: input.expectedRevision,
                  transform: (body) => {
                    if (body !== beforeBody) {
                      throw new StalePreparedMutationError('the live note changed')
                    }
                    return afterBody
                  },
                  onPrepared: async (preparation) => {
                    if (
                      preparation.beforeSource !== input.beforeSource ||
                      preparation.intendedSource !== input.afterSource
                    ) {
                      throw new StalePreparedMutationError('the live note changed')
                    }
                    await journal()
                  },
                })
              },
              closed: async () => {
                await journal()
                return await dependencies.writeNoteIfRevision(
                  input.path,
                  input.afterSource,
                  input.expectedRevision,
                  options.graphGeneration,
                )
              },
            },
            dependencies.lookupSession,
          )

          if ('status' in outcome) {
            if (outcome.status === 'applied') {
              if (!(await finalizeAppliedChange(dependencies, options, changeId))) {
                return failedChangeFinalization()
              }
              return successfulMutation(
                changeId,
                input.path,
                outcome.afterRevision,
                input.beforeSource,
                outcome.afterSource,
              )
            }
            if (outcome.status === 'unchanged') {
              return failure('failed', 'The requested edit did not change the note.')
            }
            if (outcome.status === 'stale') {
              if (prepared) {
                await bestEffortState(
                  dependencies,
                  options,
                  changeId,
                  'prepared',
                  'failed',
                  'The note changed before the edit could be applied.',
                )
              }
              return failure('stale', 'The note changed. Read it again before editing.')
            }
            if (outcome.status === 'refused') {
              if (prepared) {
                await bestEffortState(
                  dependencies,
                  options,
                  changeId,
                  'prepared',
                  'failed',
                  outcome.reason,
                )
              }
              return sessionRefusal(outcome.reason)
            }
            await bestEffortState(
              dependencies,
              options,
              changeId,
              'prepared',
              'uncertain',
              outcome.reason,
            )
            if (outcome.reason === 'persisted_write_contended') {
              return failure(
                'failed',
                'The note changed while the edit was being verified. Review it before retrying.',
              )
            }
            return failure(
              'failed',
              'The edit may have landed but could not be verified. Review the note before retrying.',
            )
          }

          if (outcome.kind === 'written') {
            if (!(await finalizeAppliedChange(dependencies, options, changeId))) {
              return failedChangeFinalization()
            }
            return successfulMutation(
              changeId,
              input.path,
              outcome.revision,
              input.beforeSource,
              input.afterSource,
            )
          }
          if (outcome.kind === 'contended') {
            await bestEffortState(
              dependencies,
              options,
              changeId,
              'prepared',
              'uncertain',
              'The note changed while the guarded write was being verified.',
            )
            return failure(
              'failed',
              'The note changed while the edit was being verified. Review it before retrying.',
            )
          }
          if (outcome.kind === 'blocked') {
            await bestEffortState(
              dependencies,
              options,
              changeId,
              'prepared',
              'failed',
              'Another live editor owns this note.',
            )
            return failure('unavailable', 'Another live editor is using this note.')
          }
          await bestEffortState(dependencies, options, changeId, 'prepared', 'failed', outcome.kind)
          return outcome.kind === 'stale'
            ? failure('stale', 'The note changed. Read it again before editing.')
            : failure('not_found', 'The note no longer exists.')
        } catch (cause) {
          if (prepared) {
            const reconciled = await reconcilePreparedMutation(
              dependencies,
              input.path,
              options.graphGeneration,
              input.beforeSource,
              input.afterSource,
              requesterOwnerId,
            )
            if (reconciled === 'applied') {
              if (!(await finalizeAppliedChange(dependencies, options, changeId))) {
                return failedChangeFinalization()
              }
              return successfulMutation(
                changeId,
                input.path,
                preparedChange.afterRevision,
                input.beforeSource,
                input.afterSource,
              )
            }
            await bestEffortState(
              dependencies,
              options,
              changeId,
              'prepared',
              reconciled,
              errorMessage(cause),
            )
            if (reconciled === 'uncertain') {
              return failure(
                'failed',
                'The edit may have landed but could not be verified. Review the note before retrying.',
              )
            }
          } else if (journalAttempted) {
            // A rejected prepare prevents dispatching the filesystem mutation.
            // The command response itself may have been lost, so retire a row
            // that did land rather than leaving it indefinitely prepared.
            await bestEffortState(
              dependencies,
              options,
              changeId,
              'prepared',
              'failed',
              errorMessage(cause),
            )
          }
          return cause instanceof StalePreparedMutationError
            ? failure('stale', 'The note changed. Read it again before editing.')
            : failure('failed', 'The note could not be changed.')
        }
      }),
    )
  }

  async function createNote(input: CreateChatNoteInput): Promise<NoteMutationOutput> {
    if (sealed) {
      return sealedMutationFailure()
    }
    const changeSequence = sequence()
    // Creation discovers its collision-safe path inside the operation. A
    // turn-scoped sentinel keeps creates ordered with one another; the native
    // no-clobber claim still closes races with other app/process work.
    return await track(
      queue.run('__create__', async () => {
        const indexGeneration = options.indexGeneration
        if (indexGeneration === null) {
          return failure('unavailable', 'Durable change history is unavailable for this graph.')
        }
        const changeId = dependencies.randomId()
        const preparation: {
          journalAttempted: boolean
          prepared: boolean
          creation: PreparedNoteCreation | null
        } = { journalAttempted: false, prepared: false, creation: null }
        try {
          const creation = await dependencies.createNote(
            input.title,
            options.graphGeneration,
            input.body,
            async (candidate) => {
              preparation.creation = candidate
              const refusal = validateMutationSources(candidate.path, null, candidate.source)
              if (refusal !== null) {
                throw new Error(refusal.message)
              }
              preparation.journalAttempted = true
              await dependencies.prepareChange({
                change: {
                  id: changeId,
                  conversationId: options.conversationId,
                  turnId: options.turnId,
                  toolCallId: input.toolCallId,
                  path: candidate.path,
                  sequence: changeSequence,
                  operation: 'create',
                  beforeSource: null,
                  afterSource: candidate.source,
                  beforeRevision: null,
                  afterRevision: candidate.revision,
                  createdMs: dependencies.now(),
                },
                generation: indexGeneration,
              })
              preparation.prepared = true
            },
          )
          if (!(await finalizeAppliedChange(dependencies, options, changeId))) {
            return failedChangeFinalization()
          }
          return successfulMutation(changeId, creation.path, creation.revision, '', creation.source)
        } catch (cause) {
          if (preparation.journalAttempted) {
            const definitiveRefusal = cause instanceof PreparedNoteCreationRefusal
            const preparedCreation = preparation.creation
            const reconciled =
              preparation.prepared && preparedCreation !== null && !definitiveRefusal
                ? await reconcilePreparedMutation(
                    dependencies,
                    preparedCreation.path,
                    options.graphGeneration,
                    null,
                    preparedCreation.source,
                  )
                : 'failed'
            if (reconciled === 'applied' && preparedCreation !== null) {
              if (!(await finalizeAppliedChange(dependencies, options, changeId))) {
                return failedChangeFinalization()
              }
              return successfulMutation(
                changeId,
                preparedCreation.path,
                preparedCreation.revision,
                '',
                preparedCreation.source,
              )
            }
            await bestEffortState(
              dependencies,
              options,
              changeId,
              'prepared',
              reconciled,
              errorMessage(cause),
            )
            if (reconciled === 'uncertain') {
              return failure(
                'failed',
                'The note may have been created but could not be verified. Review your notes before retrying.',
              )
            }
          }
          if (cause instanceof PreparedNoteCreationRefusal && cause.kind === 'blocked') {
            return failure('unavailable', 'Another live editor is using this note.')
          }
          return failure('failed', 'The note could not be created.')
        }
      }),
    )
  }

  async function settled(): Promise<void> {
    while (active.size > 0) {
      await Promise.allSettled(active)
    }
  }

  function seal(): void {
    sealed = true
  }

  return { readNote: read, applyChange, createNote, seal, settled }
}

export interface DesktopChatNoteChangeServiceOptions {
  readonly graphGeneration: number
  readonly indexGeneration: number
  /** Test seam; production callers use the native/core defaults. */
  readonly dependencies?: Partial<DesktopChatNoteHostDependencies> | undefined
}

export interface ChatNoteUndoFailure {
  readonly path: string
  readonly code: 'stale' | 'missing' | 'unavailable' | 'invalid_state' | 'contended' | 'failed'
  readonly message: string
}

export interface ChatNoteUndoResult {
  readonly ok: boolean
  readonly undonePaths: readonly string[]
  readonly failures: readonly ChatNoteUndoFailure[]
}

export interface ChatNoteReconciliation {
  readonly changeId: string
  readonly path: string
  readonly state: 'applied' | 'undone' | 'failed' | 'uncertain'
}

/** Graph-scoped recovery and Undo operations shared by desktop and iOS chat UI. */
export interface DesktopChatNoteChangeService {
  reconcilePendingChanges: () => Promise<ChatNoteReconciliation[]>
  undoTurn: (changes: readonly ChatNoteChange[]) => Promise<ChatNoteUndoResult>
  undoPath: (changes: readonly ChatNoteChange[], path: string) => Promise<ChatNoteUndoResult>
}

/** Create the local Review/Undo service for one open graph session. */
export function createDesktopChatNoteChangeService(
  options: DesktopChatNoteChangeServiceOptions,
): DesktopChatNoteChangeService {
  const dependencies: DesktopChatNoteHostDependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  }
  const coordinator = coordinatorFor(options.graphGeneration, options.indexGeneration)

  async function inspectPath(path: string): Promise<InspectedNote> {
    return await coordinator.queue.run(path, async () => {
      try {
        return await routeNoteOperation(
          path,
          {
            open: async (session) => {
              const { fresh, persistedSource } = await readFreshOpenNote(
                session,
                path,
                options.graphGeneration,
                (readPath, generation) =>
                  guardedAiRead(dependencies, readPath, generation, session.ownerId ?? undefined),
              )
              if (
                (persistedSource !== null && isPrivateSource(path, persistedSource)) ||
                (fresh !== null && isPrivateSource(path, fresh.source))
              ) {
                return { kind: 'unavailable' as const }
              }
              return fresh === null
                ? { kind: 'unavailable' as const }
                : { kind: 'content' as const, source: fresh.source, revision: fresh.revision }
            },
            closed: async () => {
              const source = await guardedAiRead(dependencies, path, options.graphGeneration)
              return { kind: 'content' as const, source, revision: await hashContent(source) }
            },
          },
          dependencies.lookupSession,
        )
      } catch (cause) {
        return (isAppError(cause) && cause.kind === 'notFound') ||
          (cause instanceof GuardedAiReadError && cause.kind === 'missing')
          ? { kind: 'missing' as const }
          : { kind: 'unavailable' as const }
      }
    })
  }

  async function reconcilePendingChanges(): Promise<ChatNoteReconciliation[]> {
    const changes = await dependencies.pendingChanges(options.indexGeneration)
    const states = new Map<string, ChatNoteReconciliation['state']>()
    const recoveringUndoIds = new Set<string>()

    for (const group of groupRecoveringUndoChanges(changes)) {
      const inspected = await inspectPath(group.path)
      const state = recoveredUndoGroupState(group, inspected)
      try {
        await dependencies.setChangesStateBatch({
          ids: group.changes.map((change) => change.id),
          expectedState: group.expectedState,
          state,
          errorMessage:
            state === 'uncertain'
              ? undoUncertainMessage('Current note bytes match neither Undo checkpoint.')
              : null,
          updatedMs: dependencies.now(),
          generation: options.indexGeneration,
        })
      } catch {
        // Recovery is idempotent. A later graph open retries abandoned rows.
      }
      for (const change of group.changes) {
        recoveringUndoIds.add(change.id)
        states.set(change.id, state)
      }
    }

    for (const change of changes) {
      if (recoveringUndoIds.has(change.id)) {
        continue
      }
      const inspected = await inspectPath(change.path)
      const state = recoveredChangeState(change, inspected)
      await bestEffortState(
        dependencies,
        options,
        change.id,
        change.state,
        state,
        state === 'uncertain' ? 'Current note bytes match neither checkpoint revision.' : null,
      )
      states.set(change.id, state)
    }
    return changes.map((change) => ({
      changeId: change.id,
      path: change.path,
      state: states.get(change.id) ?? 'uncertain',
    }))
  }

  async function undoTurn(changes: readonly ChatNoteChange[]): Promise<ChatNoteUndoResult> {
    const unresolvedFailures = unresolvedTurnUndoFailures(changes)
    if (unresolvedFailures.length > 0) {
      return { ok: false, undonePaths: [], failures: unresolvedFailures }
    }
    const groups = groupAppliedChanges(changes)
    return groups.length === 0 && changes.some((change) => change.state === 'undone')
      ? alreadyUndone()
      : await undoGroups(groups, true)
  }

  async function undoPath(
    changes: readonly ChatNoteChange[],
    path: string,
  ): Promise<ChatNoteUndoResult> {
    const pathChanges = changes.filter((change) => change.path === path)
    const groups = groupAppliedChanges(pathChanges)
    return groups.length === 0 && pathChanges.some((change) => change.state === 'undone')
      ? alreadyUndone()
      : await undoGroups(groups, false)
  }

  async function undoGroups(
    groups: readonly AppliedChangeGroup[],
    preflightAll: boolean,
  ): Promise<ChatNoteUndoResult> {
    if (groups.length === 0) {
      return {
        ok: false,
        undonePaths: [],
        failures: [
          { path: '', code: 'invalid_state', message: 'There are no applied changes to undo.' },
        ],
      }
    }

    if (preflightAll) {
      const failures: ChatNoteUndoFailure[] = []
      for (const group of groups) {
        const inspected = await inspectPath(group.path)
        const failure = inspectionFailure(group, inspected)
        if (failure !== null) {
          failures.push(failure)
        }
      }
      if (failures.length > 0) {
        return { ok: false, undonePaths: [], failures }
      }
    }

    const allChanges = groups.flatMap((group) => group.changes)
    const claimed = await transitionUndoState(allChanges, 'applied', 'undoing', null)
    if (!claimed) {
      return {
        ok: false,
        undonePaths: [],
        failures: groups.map((group) =>
          undoFailure(
            group.path,
            'invalid_state',
            'This change is already being handled or is no longer applied.',
          ),
        ),
      }
    }

    const undonePaths: string[] = []
    const failures: ChatNoteUndoFailure[] = []
    for (const group of groups.toReversed()) {
      const result = await coordinator.queue.run(group.path, async () => await undoGroup(group))
      if (result === null) {
        const finalized = await transitionUndoState(group.changes, 'undoing', 'undone', null)
        if (finalized) {
          undonePaths.push(group.path)
        } else {
          await transitionUndoState(
            group.changes,
            'undoing',
            'uncertain',
            'The note was restored but the Undo audit state could not be finalized.',
          )
          failures.push(
            undoFailure(
              group.path,
              'failed',
              'The note was restored, but its Undo audit state could not be finalized.',
            ),
          )
        }
      } else {
        const definiteRefusal = isDefiniteUndoRefusal(result)
        await transitionUndoState(
          group.changes,
          'undoing',
          definiteRefusal ? 'applied' : 'uncertain',
          result.message,
        )
        failures.push(result)
      }
    }
    return { ok: failures.length === 0, undonePaths, failures }
  }

  async function transitionUndoState(
    changes: readonly ChatNoteChange[],
    expectedState: ChatNoteChangeState,
    state: ChatNoteChangeState,
    stateError: string | null,
  ): Promise<boolean> {
    try {
      const outcome = await dependencies.setChangesStateBatch({
        ids: changes.map((change) => change.id),
        expectedState,
        state,
        errorMessage:
          state === 'uncertain'
            ? undoUncertainMessage(stateError ?? 'The Undo outcome could not be verified.')
            : stateError,
        updatedMs: dependencies.now(),
        generation: options.indexGeneration,
      })
      return outcome.kind === 'updated'
    } catch {
      return false
    }
  }

  async function undoGroup(group: AppliedChangeGroup): Promise<ChatNoteUndoFailure | null> {
    const last = group.changes.at(-1)!
    const first = group.changes[0]!
    try {
      if (first.beforeSource === null) {
        const outcome = await routeNoteOperation(
          group.path,
          {
            open: async (session) => {
              const { fresh, persistedSource } = await readFreshOpenNote(
                session,
                group.path,
                options.graphGeneration,
                (readPath, generation) =>
                  guardedAiRead(dependencies, readPath, generation, session.ownerId ?? undefined),
              )
              if (fresh === null || fresh.revision !== last.afterRevision) {
                return { kind: 'stale' as const }
              }
              if (
                (persistedSource !== null && isPrivateSource(group.path, persistedSource)) ||
                isPrivateSource(group.path, fresh.source)
              ) {
                return { kind: 'stale' as const }
              }
              return await session.commitConditionalTrash({
                expectedRevision: last.afterRevision,
                trash: async (expectedRevision) =>
                  await dependencies.trashNoteIfRevision(
                    group.path,
                    expectedRevision,
                    options.graphGeneration,
                    session.ownerId ?? undefined,
                  ),
              })
            },
            closed: async () =>
              await dependencies.trashNoteIfRevision(
                group.path,
                last.afterRevision,
                options.graphGeneration,
              ),
          },
          dependencies.lookupSession,
        )
        if (outcome.kind !== 'trashed') {
          if (outcome.kind === 'refused') {
            return undoFailure(
              group.path,
              'unavailable',
              'The open note cannot currently be removed.',
            )
          }
          if (outcome.kind === 'contended') {
            return undoFailure(
              group.path,
              'contended',
              'The note reappeared while Undo was being verified; its outcome is uncertain.',
            )
          }
          if (outcome.kind === 'blocked') {
            return undoFailure(group.path, 'unavailable', 'Another live editor is using this note.')
          }
          return outcome.kind === 'missing'
            ? undoFailure(group.path, 'missing', 'The created note no longer exists.')
            : undoFailure(group.path, 'stale', 'The note changed after the AI edit.')
        }
      } else {
        const beforeBody = splitFrontmatter(first.beforeSource).body
        const outcome = await routeNoteOperation<NoteBodyMutationResult | NoteRevisionWriteOutcome>(
          group.path,
          {
            open: async (session) =>
              await session.commitBodyMutation({
                expectedRevision: last.afterRevision,
                transform: () => beforeBody,
              }),
            closed: async () =>
              await dependencies.writeNoteIfRevision(
                group.path,
                first.beforeSource!,
                last.afterRevision,
                options.graphGeneration,
              ),
          },
          dependencies.lookupSession,
        )
        const failure = mutationUndoFailure(group.path, outcome)
        if (failure !== null) {
          return failure
        }
      }

      return null
    } catch {
      return undoFailure(group.path, 'failed', 'The note could not be restored.')
    }
  }

  return { reconcilePendingChanges, undoTurn, undoPath }
}

type InspectedNote =
  | { readonly kind: 'content'; readonly source: string; readonly revision: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }

interface RecoveringUndoGroup {
  readonly path: string
  readonly expectedState: Extract<ChatNoteChangeState, 'undoing' | 'uncertain'>
  readonly changes: readonly ChatNoteChange[]
}

function groupRecoveringUndoChanges(changes: readonly ChatNoteChange[]): RecoveringUndoGroup[] {
  const groups = new Map<string, ChatNoteChange[]>()
  for (const change of changes) {
    const expectedState =
      change.state === 'undoing'
        ? 'undoing'
        : change.state === 'uncertain' && isUndoUncertain(change)
          ? 'uncertain'
          : null
    if (expectedState === null) {
      continue
    }
    // One atomic Undo claim stamps every row with the same updatedMs. Include
    // turn and path so unrelated Undo work can never be reconciled together.
    const key = `${expectedState}\0${change.turnId}\0${change.path}\0${change.updatedMs}`
    const group = groups.get(key) ?? []
    group.push(change)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    path: group[0]!.path,
    expectedState: group[0]!.state === 'undoing' ? 'undoing' : 'uncertain',
    changes: group.toSorted((left, right) => left.sequence - right.sequence),
  }))
}

function recoveredUndoGroupState(
  group: RecoveringUndoGroup,
  inspected: InspectedNote,
): Extract<ChatNoteReconciliation['state'], 'applied' | 'undone' | 'uncertain'> {
  const first = group.changes[0]!
  const last = group.changes.at(-1)!
  const matchesBefore =
    (first.beforeRevision !== null &&
      inspected.kind === 'content' &&
      inspected.revision === first.beforeRevision) ||
    (first.beforeSource === null && inspected.kind === 'missing')
  if (matchesBefore) {
    return 'undone'
  }
  return inspected.kind === 'content' && inspected.revision === last.afterRevision
    ? 'applied'
    : 'uncertain'
}

function recoveredChangeState(
  change: ChatNoteChange,
  inspected: InspectedNote,
): ChatNoteReconciliation['state'] {
  // `pendingChanges` never returns current-process prepared rows. They remain
  // owned by the short mutation that created them, so recovery cannot race a
  // write that is still allowed to land in another webview.
  const matchesAfter = inspected.kind === 'content' && inspected.revision === change.afterRevision
  const matchesBefore =
    (inspected.kind === 'content' &&
      change.beforeRevision !== null &&
      inspected.revision === change.beforeRevision) ||
    (inspected.kind === 'missing' && change.operation === 'create')
  if (matchesAfter) {
    return 'applied'
  }
  return matchesBefore ? 'failed' : 'uncertain'
}

function undoUncertainMessage(message: string): string {
  return message.startsWith(UNDO_UNCERTAIN_PREFIX) ? message : `${UNDO_UNCERTAIN_PREFIX}${message}`
}

function isUndoUncertain(change: ChatNoteChange): boolean {
  return change.errorMessage?.startsWith(UNDO_UNCERTAIN_PREFIX) ?? false
}

interface AppliedChangeGroup {
  readonly path: string
  readonly changes: readonly ChatNoteChange[]
}

function groupAppliedChanges(changes: readonly ChatNoteChange[]): AppliedChangeGroup[] {
  const byPath = new Map<string, ChatNoteChange[]>()
  for (const change of [...changes].sort((left, right) => left.sequence - right.sequence)) {
    if (change.state !== 'applied') {
      continue
    }
    const group = byPath.get(change.path) ?? []
    group.push(change)
    byPath.set(change.path, group)
  }
  return [...byPath].map(([path, grouped]) => ({ path, changes: grouped }))
}

function unresolvedTurnUndoFailures(changes: readonly ChatNoteChange[]): ChatNoteUndoFailure[] {
  const unresolvedPaths = new Set<string>()
  for (const change of changes) {
    if (change.state === 'prepared' || change.state === 'undoing' || change.state === 'uncertain') {
      unresolvedPaths.add(change.path)
    }
  }
  return [...unresolvedPaths].map((path) =>
    undoFailure(
      path,
      'invalid_state',
      'This note has an unresolved change and cannot be included in whole-turn Undo.',
    ),
  )
}

function inspectionFailure(
  group: AppliedChangeGroup,
  inspected: InspectedNote,
): ChatNoteUndoFailure | null {
  if (inspected.kind === 'missing') {
    return undoFailure(group.path, 'missing', 'The note no longer exists.')
  }
  if (inspected.kind === 'unavailable') {
    return undoFailure(group.path, 'unavailable', 'The note is not available for Undo.')
  }
  if (inspected.revision !== group.changes.at(-1)!.afterRevision) {
    return undoFailure(group.path, 'stale', 'The note changed after the AI edit.')
  }
  return null
}

function mutationUndoFailure(
  path: string,
  outcome: NoteBodyMutationResult | NoteRevisionWriteOutcome,
): ChatNoteUndoFailure | null {
  if ('status' in outcome) {
    if (outcome.status === 'applied' || outcome.status === 'unchanged') {
      return null
    }
    if (outcome.status === 'stale') {
      return undoFailure(path, 'stale', 'The note changed after the AI edit.')
    }
    if (outcome.status === 'refused') {
      if (outcome.reason === 'missing') {
        return undoFailure(path, 'missing', 'The note no longer exists.')
      }
      return undoFailure(path, 'unavailable', 'The open note cannot currently be restored.')
    }
    return outcome.reason === 'persisted_write_contended'
      ? undoFailure(
          path,
          'contended',
          'The note changed while Undo was being verified; its outcome is uncertain.',
        )
      : undoFailure(path, 'failed', 'The restored note could not be verified.')
  }
  if (outcome.kind === 'written') {
    return null
  }
  if (outcome.kind === 'contended') {
    return undoFailure(
      path,
      'contended',
      'The note changed while Undo was being verified; its outcome is uncertain.',
    )
  }
  if (outcome.kind === 'blocked') {
    return undoFailure(path, 'unavailable', 'Another live editor is using this note.')
  }
  return outcome.kind === 'missing'
    ? undoFailure(path, 'missing', 'The note no longer exists.')
    : undoFailure(path, 'stale', 'The note changed after the AI edit.')
}

function undoFailure(
  path: string,
  code: ChatNoteUndoFailure['code'],
  message: string,
): ChatNoteUndoFailure {
  return { path, code, message }
}

function isDefiniteUndoRefusal(failure: ChatNoteUndoFailure): boolean {
  return (
    failure.code === 'stale' ||
    failure.code === 'missing' ||
    failure.code === 'unavailable' ||
    failure.code === 'invalid_state'
  )
}

function alreadyUndone(): ChatNoteUndoResult {
  return { ok: true, undonePaths: [], failures: [] }
}

function validateMutationSources(
  path: string,
  beforeSource: string | null,
  afterSource: string,
): Extract<NoteMutationOutput, { ok: false }> | null {
  if (!isNotePath(path) || isTemplatePath(path)) {
    return failure('invalid_path', 'This path is not an editable note.')
  }
  for (const source of beforeSource === null ? [afterSource] : [beforeSource, afterSource]) {
    const note = parseNote({ path, source })
    if (note.frontmatter.private) {
      return failure('private', 'This note is private and cannot be edited by AI.')
    }
    if (detectConflictMarkers(source)) {
      return failure('conflict', 'Resolve this note’s sync conflict before editing it with AI.')
    }
    if (checkRoundTrip(splitFrontmatter(source).body) === 'lossy') {
      return failure('protected', 'This note cannot be safely changed by the editor.')
    }
  }
  if (beforeSource !== null) {
    const before = splitFrontmatter(beforeSource)
    const after = splitFrontmatter(afterSource)
    if (
      beforeSource.slice(0, before.bodyOffset) !== afterSource.slice(0, after.bodyOffset) ||
      parseNote({ path, source: beforeSource }).title !==
        parseNote({ path, source: afterSource }).title
    ) {
      return failure('protected', 'AI edits cannot change note metadata or title.')
    }
  }
  return null
}

function sessionRefusal(
  reason:
    | 'no_write'
    | 'disposed'
    | 'protected'
    | 'not_ready'
    | 'missing'
    | 'conflict'
    | 'owned_elsewhere'
    | 'unsafe_result',
): Extract<NoteMutationOutput, { ok: false }> {
  if (reason === 'missing') {
    return failure('not_found', 'The note no longer exists.')
  }
  if (reason === 'protected' || reason === 'unsafe_result') {
    return failure('protected', 'This open note cannot be safely changed.')
  }
  if (reason === 'conflict') {
    return failure('conflict', 'Resolve this note’s sync conflict before editing it with AI.')
  }
  if (reason === 'owned_elsewhere') {
    return failure('unavailable', 'Another live editor is using this note.')
  }
  return failure('unavailable', 'The open note is not ready for editing.')
}

function isPrivateSource(path: string, source: string): boolean {
  return parseNote({ path, source }).frontmatter.private
}

async function readFreshOpenNote(
  session: NoteSession,
  path: string,
  generation: number,
  readPersisted: (path: string, generation: number) => Promise<string>,
): Promise<{ readonly fresh: NoteFreshContent | null; readonly persistedSource: string | null }> {
  let persistedSource: string | null = null
  const fresh = await session.readFreshContent(async () => {
    const source = await readPersisted(path, generation)
    persistedSource = source
    return source
  })
  return { fresh, persistedSource }
}

async function guardedAiRead(
  dependencies: Pick<DesktopChatNoteHostDependencies, 'readNoteForAi'>,
  path: string,
  generation: number,
  requesterOwnerId?: string,
): Promise<string> {
  const outcome = await dependencies.readNoteForAi(path, generation, requesterOwnerId)
  if (outcome.kind === 'content') {
    return outcome.source
  }
  throw new GuardedAiReadError(outcome.kind)
}

type PreparedMutationReconciliation = 'applied' | 'failed' | 'uncertain'

/** Classify a lost mutation response from exact authoritative bytes only. */
async function reconcilePreparedMutation(
  dependencies: Pick<DesktopChatNoteHostDependencies, 'readNoteForAi'>,
  path: string,
  generation: number,
  beforeSource: string | null,
  afterSource: string,
  requesterOwnerId?: string,
): Promise<PreparedMutationReconciliation> {
  try {
    const current = await dependencies.readNoteForAi(path, generation, requesterOwnerId)
    if (current.kind === 'missing') {
      return 'failed'
    }
    if (current.kind === 'blocked') {
      return 'uncertain'
    }
    if (current.source === afterSource) {
      return 'applied'
    }
    if (beforeSource !== null && current.source === beforeSource) {
      return 'failed'
    }
    return 'uncertain'
  } catch {
    return 'uncertain'
  }
}

function successfulMutation(
  changeId: string,
  path: string,
  revision: string,
  beforeSource: string,
  afterSource: string,
): Extract<NoteMutationOutput, { ok: true }> {
  const statistics = changedLineStatistics(beforeSource, afterSource)
  return { ok: true, changeId, path, revision, ...statistics }
}

function changedLineStatistics(
  beforeSource: string,
  afterSource: string,
): { addedLines: number; removedLines: number } {
  const beforeBody = beforeSource === '' ? '' : splitFrontmatter(beforeSource).body
  const afterBody = splitFrontmatter(afterSource).body
  let addedLines = 0
  let removedLines = 0
  for (const part of diffLines(beforeBody, afterBody)) {
    if (part.added) {
      addedLines += physicalLineCount(part.value)
    } else if (part.removed) {
      removedLines += physicalLineCount(part.value)
    }
  }
  return { addedLines, removedLines }
}

function physicalLineCount(value: string): number {
  if (value === '') {
    return 0
  }
  const newlineCount = value.match(/\n/g)?.length ?? 0
  return newlineCount + (value.endsWith('\n') ? 0 : 1)
}

async function bestEffortState(
  dependencies: DesktopChatNoteHostDependencies,
  options: { readonly indexGeneration: number | null },
  id: string,
  expectedState: ChatNoteChangeState,
  state: ChatNoteChangeState,
  stateError: string | null,
): Promise<void> {
  if (options.indexGeneration === null) {
    return
  }
  try {
    await dependencies.setChangeState({
      id,
      expectedState,
      state,
      errorMessage: stateError,
      updatedMs: dependencies.now(),
      generation: options.indexGeneration,
    })
  } catch {
    // The filesystem result remains authoritative. A prepared row is
    // intentionally recoverable on next launch if this metadata write fails.
  }
}

async function finalizeAppliedChange(
  dependencies: DesktopChatNoteHostDependencies,
  options: { readonly indexGeneration: number | null },
  id: string,
): Promise<boolean> {
  const indexGeneration = options.indexGeneration
  if (indexGeneration === null) {
    return false
  }
  const transition = async (): Promise<SetChatNoteChangeStateResult> =>
    await dependencies.setChangeState({
      id,
      expectedState: 'prepared',
      state: 'applied',
      errorMessage: null,
      updatedMs: dependencies.now(),
      generation: indexGeneration,
    })

  try {
    const finalized = await transition()
    if (
      finalized.kind === 'updated' ||
      (finalized.kind === 'stateMismatch' && finalized.change.state === 'applied')
    ) {
      return true
    }
  } catch {
    // A lost response may have committed the CAS. Retry it once: a returned
    // applied state is the idempotent success echo for that ambiguity.
    try {
      const retried = await transition()
      if (
        retried.kind === 'updated' ||
        (retried.kind === 'stateMismatch' && retried.change.state === 'applied')
      ) {
        return true
      }
    } catch {
      // Preserve the recoverable state below.
    }
  }
  await bestEffortState(
    dependencies,
    options,
    id,
    'prepared',
    'uncertain',
    'The note write landed but its applied audit state could not be finalized.',
  )
  return false
}

function failedChangeFinalization(): Extract<NoteMutationOutput, { ok: false }> {
  return failure(
    'failed',
    'The note changed, but its review checkpoint could not be finalized. Review it before continuing.',
  )
}

function sealedMutationFailure(): Extract<NoteMutationOutput, { ok: false }> {
  return failure('unavailable', 'This chat turn is no longer accepting note changes.')
}

function failure(
  code: Extract<NoteMutationOutput, { ok: false }>['code'],
  message: string,
): Extract<NoteMutationOutput, { ok: false }> {
  return { ok: false, code, message }
}
