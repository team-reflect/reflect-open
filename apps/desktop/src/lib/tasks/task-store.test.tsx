import { beforeEach, expect, it, vi } from 'vitest'
import type { Task } from '@reflect/core'
import { createNoteSession } from '@/editor/note-session.ts'
import { registerOpenDocument } from '@/editor/open-documents.ts'
import { taskStore } from './task-store.ts'

const readNote = vi.hoisted(() => vi.fn<(path: string, generation?: number) => Promise<string>>())
const writeNote = vi.hoisted(() =>
  vi.fn<
    (path: string, source: string, generation: number, before?: string | null) => Promise<void>
  >(),
)
vi.mock('@reflect/core', async (original) => ({
  ...(await original<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
  indexNote: async () => {},
  emitIndexApplied: () => {},
}))
const toast = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn() }))
vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

const target = {
  notePath: 'notes/a.md',
  noteTitle: 'A',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
  breadcrumbs: [],
}
beforeEach(() => {
  readNote.mockReset()
  writeNote.mockReset()
  toast.add.mockReset()
  toast.close.mockReset()
})

it('routes through a matching live NoteSession and preserves its dirty buffer', async () => {
  let disk = '+ [ ] original\n'
  const session = createNoteSession({
    path: target.notePath,
    io: {
      read: async () => disk,
      write: async (_path, source) => {
        disk = source
      },
    },
    classify: () => 'exact',
    onSnapshot: () => {},
    applyContent: () => {},
  })
  session.load()
  await vi.waitFor(() => expect(session.liveContent()).not.toBeNull())
  session.editorChanged('+ [ ] original\n\nunsaved prose\n')
  const unregister = registerOpenDocument({ session, generation: () => 7 })
  try {
    const controller = taskStore(crypto.randomUUID(), 7)
    const row: Task = {
      ...target,
      key: 'notes/a.md#[0]',
      astPath: [0],
      text: 'original',
      displayText: 'original',
      checked: false,
      dueDate: null,
      updatedAt: 0,
    }
    controller.update(row, { text: 'edited' })
    await controller.flush()
    expect(disk).toContain('[ ] edited')
    expect(disk).toContain('unsaved prose')
    expect(writeNote).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  } finally {
    unregister()
    session.dispose()
  }
})

it('does not edit an identically named live note belonging to another graph generation', async () => {
  const session = createNoteSession({
    path: target.notePath,
    io: { read: async () => '+ [ ] other graph\n', write: null },
    classify: () => 'exact',
    onSnapshot: () => {},
    applyContent: () => {},
  })
  session.load()
  await vi.waitFor(() => expect(session.liveContent()).not.toBeNull())
  const unregister = registerOpenDocument({ session, generation: () => 9 })
  readNote.mockRejectedValue(new Error('stale generation'))
  try {
    const controller = taskStore(crypto.randomUUID(), 7)
    controller.update(controller.create(target), { text: 'old graph draft' })
    await controller.flush()
    expect(session.liveContent()).toContain('other graph')
    expect(session.liveContent()).not.toContain('old graph draft')
    expect(writeNote).not.toHaveBeenCalled()
    expect(toast.add).toHaveBeenCalledOnce()
  } finally {
    unregister()
    session.dispose()
  }
})
