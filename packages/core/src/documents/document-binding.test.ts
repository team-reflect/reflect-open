import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import {
  createDocumentBinding,
  INITIAL_DOCUMENT_VIEW,
  type BindFactories,
  type DocumentBinding,
  type DocumentCoordinator,
} from './document-binding.ts'
import {
  INITIAL_NOTE_SNAPSHOT,
  type NoteSession,
  type NoteSessionSnapshot,
} from './note-session-types.ts'
import { createOpenDocumentsService, type OpenDocumentsService } from './open-documents-service.ts'
import { noop, sleep } from '@ocavue/utils'

/**
 * The create/adopt/teardown/hand-off protocol, driven directly — the React
 * hook is a thin adapter over this. The hand-off cases mirror what a rename
 * does at runtime: retarget the live session, then either an adopting bind
 * lands (the route followed) or none does (the pane unmounted).
 */

function fakeSession(path: string) {
  const session = createTestNoteSession({ path })
  const flush = vi.spyOn(session, 'flush')
  const dispose = vi.spyOn(session, 'dispose')
  return { session, flush, dispose }
}

function fakeCoordinator() {
  const settle = vi.fn()
  const dispose = vi.fn()
  const coordinator: DocumentCoordinator = {
    settle,
    settled: noop,
    dispose,
  }
  return { coordinator, settle, dispose }
}

/**
 * Factories that build `session`, recording the `onSnapshot` it is created with in `emitters`.
 */
function factories(
  session: NoteSession,
  coordinator: DocumentCoordinator | null,
  emitters: Array<(snapshot: NoteSessionSnapshot) => void> = [],
): BindFactories {
  return {
    session: (_coordinator, onSnapshot) => {
      emitters.push(onSnapshot)
      return session
    },
    coordinator: () => coordinator,
  }
}

function readySnapshot(path: string, initialContent = ''): NoteSessionSnapshot {
  return { ...INITIAL_NOTE_SNAPSHOT, path, status: 'ready', initialContent }
}

let openDocuments: OpenDocumentsService

beforeEach(() => {
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
})

function createBinding(): DocumentBinding {
  return createDocumentBinding({ openDocuments })
}

const microtasks = () => sleep(0)

describe('createDocumentBinding', () => {
  it('creates on first bind, registers, and counts the epoch', () => {
    const binding = createBinding()
    const { session } = fakeSession('notes/a.md')
    const emitters: Array<(snapshot: NoteSessionSnapshot) => void> = []
    const bound = binding.bind('notes/a.md', factories(session, null, emitters))

    expect(bound.created).toBe(true)
    expect(binding.view.get()).toBe(INITIAL_DOCUMENT_VIEW) // nothing until the session reports
    emitters[0]?.(readySnapshot('notes/a.md', '# A\n'))
    expect(binding.view.get()).toEqual({
      epoch: 1,
      session,
      snapshot: readySnapshot('notes/a.md', '# A\n'),
    })
    expect(openDocuments.sessionFor('notes/a.md')).toBe(session)
    binding.unbind('notes/a.md')
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
    expect(binding.view.get()).toBe(INITIAL_DOCUMENT_VIEW)
  })

  it('the view changes as one value, and only through the live session', () => {
    const binding = createBinding()
    const first = fakeSession('notes/a.md')
    const emitters: Array<(snapshot: NoteSessionSnapshot) => void> = []
    binding.bind('notes/a.md', factories(first.session, null, emitters))
    emitters[0]?.(readySnapshot('notes/a.md'))
    const seen: Array<ReturnType<typeof binding.view.get>> = []
    const unsubscribe = binding.view.subscribe(() => {
      seen.push(binding.view.get())
    })

    binding.unbind('notes/a.md')
    const second = fakeSession('notes/b.md')
    binding.bind('notes/b.md', factories(second.session, null, emitters))
    emitters[0]?.(readySnapshot('notes/a.md', '# late\n')) // the torn-down session reports
    emitters[1]?.(readySnapshot('notes/b.md', '# B\n'))

    expect(seen).toEqual([
      INITIAL_DOCUMENT_VIEW,
      { epoch: 2, session: second.session, snapshot: readySnapshot('notes/b.md', '# B\n') },
    ])
    unsubscribe()
    binding.unbind('notes/b.md')
  })

  it('a same-path rebind recreates (io bindings are taken at construction)', () => {
    const binding = createBinding()
    const first = fakeSession('notes/a.md')
    const emitters: Array<(snapshot: NoteSessionSnapshot) => void> = []
    binding.bind('notes/a.md', factories(first.session, null, emitters))
    binding.unbind('notes/a.md')
    expect(first.dispose).toHaveBeenCalled()

    const second = fakeSession('notes/a.md')
    const rebound = binding.bind('notes/a.md', factories(second.session, null, emitters))
    expect(rebound.created).toBe(true)
    expect(rebound.session).toBe(second.session)
    emitters[1]?.(readySnapshot('notes/a.md'))
    expect(binding.view.get().epoch).toBe(2)
    binding.unbind('notes/a.md')
  })

  it('adopts a retargeted session when the next bind lands on its new path', async () => {
    const binding = createBinding()
    const moved = fakeSession('notes/a.md')
    const { coordinator } = fakeCoordinator()
    const emitters: Array<(snapshot: NoteSessionSnapshot) => void> = []
    binding.bind('notes/a.md', factories(moved.session, coordinator, emitters))
    emitters[0]?.(readySnapshot('notes/a.md'))

    moved.session.retarget('notes/renamed.md') // what moveNoteCarryingSession does
    emitters[0]?.(readySnapshot('notes/renamed.md'))
    binding.unbind('notes/a.md') // route follows → React cleanup for the old path
    const spare = fakeSession('notes/renamed.md')
    const adopted = binding.bind('notes/renamed.md', factories(spare.session, null, emitters))

    expect(adopted.created).toBe(false)
    expect(adopted.session).toBe(moved.session)
    expect(adopted.coordinator).toBe(coordinator)
    expect(emitters).toHaveLength(1) // no new session
    // No new epoch: the editor keeps its cursor.
    expect(binding.view.get()).toEqual({
      epoch: 1,
      session: moved.session,
      snapshot: readySnapshot('notes/renamed.md'),
    })
    await microtasks()
    expect(moved.dispose).not.toHaveBeenCalled() // the hand-off cancelled teardown

    binding.unbind('notes/renamed.md')
    expect(moved.dispose).toHaveBeenCalled()
  })

  it('tears a retargeted session down when nothing adopts it (real unmount)', async () => {
    const binding = createBinding()
    const moved = fakeSession('notes/a.md')
    const { coordinator, settle } = fakeCoordinator()
    binding.bind('notes/a.md', factories(moved.session, coordinator))

    moved.session.retarget('notes/renamed.md')
    binding.unbind('notes/a.md') // unmount: no bind follows
    expect(moved.dispose).not.toHaveBeenCalled() // deferred — not torn down inline

    await microtasks()
    expect(moved.dispose).toHaveBeenCalled()
    expect(moved.flush).toHaveBeenCalled()
    expect(settle).toHaveBeenCalled() // a pending rename still settles
  })

  it('a normal unbind settles the coordinator after the final flush', async () => {
    const binding = createBinding()
    const { session, dispose } = fakeSession('notes/a.md')
    const { coordinator, settle } = fakeCoordinator()
    binding.bind('notes/a.md', factories(session, coordinator))

    binding.unbind('notes/a.md')
    expect(dispose).toHaveBeenCalled()
    await microtasks()
    expect(settle).toHaveBeenCalledTimes(1)
  })
})
