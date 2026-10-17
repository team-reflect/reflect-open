import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import {
  createDocumentBinding,
  type BindFactories,
  type DocumentBinding,
  type DocumentCoordinator,
} from './document-binding.ts'
import type { NoteSession } from './note-session-service.ts'
import { createOpenDocumentsService, type OpenDocumentsService } from './open-documents-service.ts'

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
    settled: () => {},
    dispose,
  }
  return { coordinator, settle, dispose }
}

function factories(session: NoteSession, coordinator: DocumentCoordinator | null): BindFactories {
  return { session: () => session, coordinator: () => coordinator }
}

let openDocuments: OpenDocumentsService

beforeEach(() => {
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
})

function createBinding(): DocumentBinding {
  return createDocumentBinding({ openDocuments })
}

const microtasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createDocumentBinding', () => {
  it('creates on first bind, registers, and counts the epoch', () => {
    const binding = createBinding()
    const { session } = fakeSession('notes/a.md')
    const bound = binding.bind('notes/a.md', factories(session, null))

    expect(bound.created).toBe(true)
    expect(binding.session()).toBe(session)
    expect(binding.epoch()).toBe(1)
    expect(openDocuments.sessionFor('notes/a.md')).toBe(session)
    binding.unbind('notes/a.md')
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
  })

  it('a same-path rebind recreates (io bindings are taken at construction)', () => {
    const binding = createBinding()
    const first = fakeSession('notes/a.md')
    binding.bind('notes/a.md', factories(first.session, null))
    binding.unbind('notes/a.md')
    expect(first.dispose).toHaveBeenCalled()

    const second = fakeSession('notes/a.md')
    const rebound = binding.bind('notes/a.md', factories(second.session, null))
    expect(rebound.created).toBe(true)
    expect(rebound.session).toBe(second.session)
    expect(binding.epoch()).toBe(2)
    binding.unbind('notes/a.md')
  })

  it('adopts a retargeted session when the next bind lands on its new path', async () => {
    const binding = createBinding()
    const moved = fakeSession('notes/a.md')
    const { coordinator } = fakeCoordinator()
    binding.bind('notes/a.md', factories(moved.session, coordinator))

    moved.session.retarget('notes/renamed.md') // what moveNoteCarryingSession does
    binding.unbind('notes/a.md') // route follows → React cleanup for the old path
    const spare = fakeSession('notes/renamed.md')
    const adopted = binding.bind('notes/renamed.md', factories(spare.session, null))

    expect(adopted.created).toBe(false)
    expect(adopted.session).toBe(moved.session)
    expect(adopted.coordinator).toBe(coordinator)
    expect(binding.epoch()).toBe(1) // no remount: the editor keeps its cursor
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
