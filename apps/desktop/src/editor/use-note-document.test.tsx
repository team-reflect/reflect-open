import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { NoteEditorHandle } from './note-editor'
import { useNoteDocument } from './use-note-document'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_, handler: (event: { payload: unknown }) => void) => {
    emitChange = (payload) => handler({ payload })
    return Promise.resolve(() => {
      emitChange = null
    })
  }),
}))

let emitChange: ((payload: unknown) => void) | null = null
const mockInvoke = vi.mocked(invoke)

/** The fake on-disk file + a write log, behind the mocked IPC. */
let disk: string
let writes: string[]

function fakeEditor(): NoteEditorHandle & { applied: string[] } {
  const applied: string[] = []
  return {
    applied,
    setMarkdown: (markdown) => {
      applied.push(markdown)
    },
    getMarkdown: () => '',
    focus: () => {},
  }
}

beforeEach(() => {
  disk = '# Hello\n'
  writes = []
  emitChange = null
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      return disk
    }
    if (command === 'note_write') {
      const contents = (args as { contents: string }).contents
      disk = contents
      writes.push(contents)
      return null
    }
    return null
  })
})

async function readyHook() {
  const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
  await waitFor(() => expect(hook.result.current.status).toBe('ready'))
  return hook
}

describe('useNoteDocument', () => {
  it('loads the note and seeds the editor content', async () => {
    const { result } = await readyHook()
    expect(result.current.initialContent).toBe('# Hello\n')
    expect(result.current.dirty).toBe(false)
  })

  it('debounces edits into an atomic write and clears dirty', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      act(() => hook.result.current.onEditorChange('# Hello edited\n'))
      expect(hook.result.current.dirty).toBe(true)
      expect(writes).toEqual([])

      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(writes).toEqual(['# Hello edited\n'])
      expect(hook.result.current.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores the watcher echo of its own save', async () => {
    const { result } = await readyHook()
    const editor = fakeEditor()
    act(() => result.current.bindEditor(editor))

    // The watcher reports our own write back; content matches disk state.
    act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await act(async () => {})
    expect(editor.applied).toEqual([])
    expect(result.current.conflict).toBeNull()
  })

  it('reloads a clean buffer on a real external change', async () => {
    const { result } = await readyHook()
    const editor = fakeEditor()
    act(() => result.current.bindEditor(editor))

    disk = '# Changed outside\n'
    act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await waitFor(() => expect(editor.applied).toEqual(['# Changed outside\n']))
    expect(result.current.conflict).toBeNull()
    expect(result.current.dirty).toBe(false)
  })

  it('parks an external change as a conflict when the buffer is dirty', async () => {
    const { result } = await readyHook()
    const editor = fakeEditor()
    act(() => result.current.bindEditor(editor))

    act(() => result.current.onEditorChange('# My unsaved edit\n'))
    disk = '# Theirs\n'
    act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await waitFor(() => expect(result.current.conflict).toBe('# Theirs\n'))
    expect(editor.applied).toEqual([]) // never clobbered

    // Load theirs: applies the external content and clears the conflict.
    act(() => result.current.loadTheirs())
    expect(editor.applied).toEqual(['# Theirs\n'])
    expect(result.current.conflict).toBeNull()
    expect(result.current.dirty).toBe(false)
  })

  it('opens a note the editor would corrupt in protected mode and never saves it', async () => {
    vi.useFakeTimers()
    try {
      // meowdown's converter loses task-list text — the guard must catch it.
      disk = '- [ ] buy milk\n- [x] done\n'
      const hook = renderHook(() => useNoteDocument('notes/tasks.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')
      expect(hook.result.current.protected).toBe(true)

      // Even if an edit somehow reaches the pipeline, nothing is written.
      act(() => hook.result.current.onEditorChange('mangled'))
      await act(() => vi.advanceTimersByTimeAsync(2000))
      expect(writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an external reload never dirties the buffer, even when serialization normalizes', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))

      // The editor's change handler fires synchronously inside setMarkdown and
      // reports a *normalized* serialization (extra trailing newline) — as the
      // real editor does for e.g. loose lists.
      const editor = fakeEditor()
      const normalizing: typeof editor = {
        ...editor,
        setMarkdown: (markdown) => {
          editor.setMarkdown(markdown)
          hook.result.current.onEditorChange(`${markdown}\n`)
        },
      }
      act(() => hook.result.current.bindEditor(normalizing))

      disk = '# Changed outside\n'
      act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(editor.applied).toEqual(['# Changed outside\n'])
      expect(hook.result.current.dirty).toBe(false)

      // No save may fire from the reload alone.
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses saves while a conflict is parked (no clobbering theirs)', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))

      // An edit schedules a save, then an external change parks a conflict
      // before the debounce fires.
      act(() => hook.result.current.onEditorChange('# Mine\n'))
      disk = '# Theirs\n'
      act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.conflict).toBe('# Theirs\n')

      // Neither the pending debounce nor an explicit flush may write now.
      act(() => hook.result.current.onEditorChange('# Mine v2\n'))
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(writes).toEqual([])

      // Resolution unblocks: keepMine rewrites with the buffer.
      act(() => hook.result.current.keepMine())
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(writes).toEqual(['# Mine v2\n'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a watcher event for an in-flight save as an echo, not a conflict', async () => {
    vi.useFakeTimers()
    try {
      // Make note_write update the fake disk synchronously but resolve later,
      // simulating the watcher event racing the IPC promise settlement.
      let resolveWrite: (() => void) | null = null
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return disk
        }
        if (command === 'note_write') {
          disk = (args as { contents: string }).contents
          writes.push(disk)
          return new Promise<null>((resolve) => {
            resolveWrite = () => resolve(null)
          })
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))

      act(() => hook.result.current.onEditorChange('# Saved\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // write dispatched, unresolved
      expect(writes).toEqual(['# Saved\n'])

      // User keeps typing (dirty again) while the watcher reports our write.
      act(() => hook.result.current.onEditorChange('# Saved and more\n'))
      act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.conflict).toBeNull() // echo, not a conflict

      act(() => {
        resolveWrite?.()
      })
      await act(() => vi.advanceTimersByTimeAsync(0))
    } finally {
      vi.useRealTimers()
    }
  })

  it('a queued save re-checks the buffer at write time (revert during a slow write)', async () => {
    vi.useFakeTimers()
    try {
      // First write hangs; the queued second save must re-evaluate when it runs.
      let resolveWrite: (() => void) | null = null
      let writeCount = 0
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return disk
        }
        if (command === 'note_write') {
          disk = (args as { contents: string }).contents
          writes.push(disk)
          writeCount += 1
          if (writeCount === 1) {
            return new Promise<null>((resolve) => {
              resolveWrite = () => resolve(null)
            })
          }
          return null
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))

      act(() => hook.result.current.onEditorChange('# A\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // write1(A) dispatched, hanging
      expect(writes).toEqual(['# A\n'])

      // More typing queues a second save; then the user reverts to A before
      // write1 settles. The queued step must NOT persist the stale "# B".
      act(() => hook.result.current.onEditorChange('# B\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      act(() => hook.result.current.onEditorChange('# A\n'))
      act(() => {
        resolveWrite?.()
      })
      await act(() => vi.advanceTimersByTimeAsync(2000))
      expect(writes).toEqual(['# A\n']) // no stale second write
      expect(hook.result.current.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a failed save as error and clears it on the next success', async () => {
    vi.useFakeTimers()
    try {
      let failNext = true
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return disk
        }
        if (command === 'note_write') {
          if (failNext) {
            failNext = false
            throw new Error('disk full')
          }
          disk = (args as { contents: string }).contents
          writes.push(disk)
          return null
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))

      act(() => hook.result.current.onEditorChange('# Edited\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(hook.result.current.error).toMatch(/disk full/)
      expect(hook.result.current.status).toBe('ready') // editing continues

      // The next (successful) save clears the surfaced error.
      act(() => hook.result.current.onEditorChange('# Edited again\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(hook.result.current.error).toBeNull()
      expect(writes).toEqual(['# Edited again\n'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes the previous note when the path switches (final-flush snapshot)', async () => {
    vi.useFakeTimers()
    try {
      const written: Array<{ path: string; contents: string }> = []
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return disk
        }
        if (command === 'note_write') {
          const { path, contents } = args as { path: string; contents: string }
          written.push({ path, contents })
          return null
        }
        return null
      })

      const hook = renderHook(({ path }) => useNoteDocument(path, 1), {
        initialProps: { path: 'notes/a.md' },
      })
      await act(() => vi.advanceTimersByTimeAsync(0))

      // Dirty edit, then switch notes before the debounce fires: the unmount
      // flush must persist the OLD note's buffer to the OLD path.
      act(() => hook.result.current.onEditorChange('# Unsaved on A\n'))
      hook.rerender({ path: 'notes/b.md' })
      await act(() => vi.advanceTimersByTimeAsync(2000))

      expect(written).toContainEqual({ path: 'notes/a.md', contents: '# Unsaved on A\n' })
      expect(written.some((write) => write.path === 'notes/b.md')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keepMine rewrites the file with the buffer', async () => {
    const { result } = await readyHook()
    act(() => result.current.onEditorChange('# My unsaved edit\n'))
    disk = '# Theirs\n'
    act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await waitFor(() => expect(result.current.conflict).toBe('# Theirs\n'))

    act(() => result.current.keepMine())
    await waitFor(() => expect(writes).toContain('# My unsaved edit\n'))
    expect(result.current.conflict).toBeNull()
  })
})
