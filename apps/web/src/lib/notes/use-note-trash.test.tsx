import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestCoreServices,
  createTestNoteFileService,
  type TestNoteFileService,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteTrash } from './use-note-trash.ts'

const GRAPH: TestOpenGraph = { root: '/g', name: 'g', generation: 1 }

let noteFile: TestNoteFileService

beforeEach(() => {
  noteFile = createTestNoteFileService({
    files: { 'notes/a.md': '# Note\n', 'notes/b.md': '# Note\n', 'notes/c.md': '# Note\n' },
  })
})

async function mount(graph: TestOpenGraph | null = GRAPH) {
  return await renderHookInApp(() => useNoteTrash(), {
    core: createTestCoreServices({ database: createWasmTestDatabaseService(), noteFile }),
    graph,
  })
}

describe('useNoteTrash', () => {
  it('reports a failure without trashing when no graph is open (never a silent success)', async () => {
    const { result } = await mount(null)

    await expect(result.current.trash(['notes/a.md'])).resolves.toBe(false)
    expect(noteFile.trashed()).toEqual([])
  })

  it('is a no-op for an empty selection', async () => {
    const { result } = await mount()

    await expect(result.current.trash([])).resolves.toBe(true)
    expect(noteFile.trashed()).toEqual([])
  })

  it('trashes every note and resolves true', async () => {
    const { result } = await mount()

    let trashed = false
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'notes/b.md'])
    })

    expect(trashed).toBe(true)
    expect(noteFile.trashed()).toEqual(['notes/a.md', 'notes/b.md'])
  })

  it('keeps going past a per-note failure and resolves false', async () => {
    const files = noteFile
    const trashFile = files.delete.bind(files)
    vi.spyOn(files, 'delete').mockImplementation(async (path, generation) => {
      if (path === 'notes/b.md') {
        throw new Error('locked')
      }
      await trashFile(path, generation)
    })
    const { result } = await mount()

    let trashed = true
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'notes/b.md', 'notes/c.md'])
    })

    // The batch reports failure but still attempted (and trashed) the others.
    expect(trashed).toBe(false)
    expect(files.trashed()).toEqual(['notes/a.md', 'notes/c.md'])
  })
})
