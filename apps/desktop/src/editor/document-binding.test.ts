import { describe, expect, it, vi } from 'vitest'
import { createDocumentBinding, type BindFactories } from './document-binding'
import type { NoteSession } from './note-session'
import { openSession } from './open-documents'
import type { RenameCoordinator } from './rename-coordinator'

/**
 * The create/adopt/teardown/hand-off protocol, driven directly — the React
 * hook is a thin adapter over this. The hand-off cases mirror what a rename
 * does at runtime: retarget the live session, then either an adopting bind
 * lands (the route followed) or none does (the pane unmounted).
 */

function fakeSession(path: string) {
  let current = path
  const flush = vi.fn(async () => {})
  const dispose = vi.fn()
  const discard = vi.fn()
  const session: NoteSession = {
    get path() {
      return current
    },
    retarget: (to: string) => {
      current = to
    },
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {},
    flush,
    keepMine: () => {},
    loadTheirs: () => {},
    commitFrontmatter: async () => true,
    content: () => '',
    liveContent: () => '',
    updateFrontmatter: () => true,
    commitTaskToggle: async () => false,
    commitTaskEdit: async () => false,
    commitTaskRemove: async () => false,
    commitTaskToBullet: async () => false,
    commitBodyAppend: async () => false,
    dispose,
    discard,
  }
  return { session, flush, dispose }
}

function fakeCoordinator() {
  const settle = vi.fn()
  const dispose = vi.fn()
  const coordinator: RenameCoordinator = {
    content: () => {},
    settle,
    settled: async () => {},
    dispose,
  }
  return { coordinator, settle, dispose }
}

function factories(session: NoteSession, coordinator: RenameCoordinator | null): BindFactories {
  return { session: () => session, coordinator: () => coordinator }
}

const microtasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createDocumentBinding', () => {
  it('creates on first bind, registers, and counts the epoch', () => {
    const binding = createDocumentBinding()
    const { session } = fakeSession('notes/a.md')
    const bound = binding.bind('notes/a.md', factories(session, null))

    expect(bound.created).toBe(true)
    expect(binding.session()).toBe(session)
    expect(binding.epoch()).toBe(1)
    expect(openSession('notes/a.md')).toBe(session)
    binding.unbind('notes/a.md')
    expect(openSession('notes/a.md')).toBeNull()
  })

  it('a same-path rebind recreates (io bindings are taken at construction)', () => {
    const binding = createDocumentBinding()
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
    const binding = createDocumentBinding()
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
    const binding = createDocumentBinding()
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
    const binding = createDocumentBinding()
    const { session, dispose } = fakeSession('notes/a.md')
    const { coordinator, settle } = fakeCoordinator()
    binding.bind('notes/a.md', factories(session, coordinator))

    binding.unbind('notes/a.md')
    expect(dispose).toHaveBeenCalled()
    await microtasks()
    expect(settle).toHaveBeenCalledTimes(1)
  })
})
