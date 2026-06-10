import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { flushAllNotes } from './flush-registry'
import type { NoteEditorHandle } from './note-editor'
import { useNoteDocument } from './use-note-document'

let emitChange: ((payload: unknown) => void) | null = null
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({
  invoke: mockInvoke,
  listen: async (_event, handler) => {
    emitChange = handler
    return () => {
      emitChange = null
    }
  },
})

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

  it('flushAllNotes persists a pending edit without waiting out the debounce (quit path)', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      act(() => hook.result.current.onEditorChange('# Quitting\n'))
      expect(writes).toEqual([]) // still inside the 800ms debounce window

      // The quit path: the registry flush settles only once the write has
      // landed — no timer advance, the way a ⌘Q teardown would run it.
      await act(() => flushAllNotes())
      expect(writes).toEqual(['# Quitting\n'])
      expect(hook.result.current.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('unmounting unregisters the buffer from the quit-flush registry', async () => {
    const hook = await readyHook()
    act(() => hook.result.current.onEditorChange('# Edited\n'))
    hook.unmount() // unmount itself flushes once (the existing final-flush path)
    await act(async () => {})
    const writesAfterUnmount = writes.length

    await flushAllNotes() // the unmounted buffer must no longer be registered
    expect(writes.length).toBe(writesAfterUnmount)
  })

  it('a settled title change rewrites inbound links and records the alias (Plan 07b)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return files[(args as { path: string }).path]
        }
        if (command === 'note_write') {
          const { path: writePath, contents } = args as { path: string; contents: string }
          files[writePath] = contents
          return null
        }
        if (command === 'db_query') {
          const sql = String((args as { sql: string }).sql)
          if (sql.includes('"links"')) {
            return [{ source_path: 'notes/src.md' }] // the one inbound source
          }
          return [] // resolver lookups: unresolved → no collision
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // the rename save lands

      // Blur is a settle point: the rewrite fires without waiting out the
      // quiet period, then the alias lands through the normal save pipeline.
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await act(() => vi.runAllTimersAsync())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      expect(files['notes/a.md']).toContain('aliases:')
      expect(files['notes/a.md']).toContain('Old Title')
      expect(files['notes/a.md'].endsWith('# New Title\n')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rename settled by pane teardown still rewrites links and lands the alias', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return files[(args as { path: string }).path]
        }
        if (command === 'note_write') {
          const { path: writePath, contents } = args as { path: string; contents: string }
          files[writePath] = contents
          return null
        }
        if (command === 'db_query') {
          const sql = String((args as { sql: string }).sql)
          return sql.includes('"links"') ? [{ source_path: 'notes/src.md' }] : []
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // save lands, quiet timer armed

      hook.unmount() // teardown settles the tracker — the session is disposed
      await act(() => vi.runAllTimersAsync())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      // The alias can't go through the disposed session — it lands on disk.
      expect(files['notes/a.md']).toContain('aliases:')
      expect(files['notes/a.md']).toContain('Old Title')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rename settling after a note switch never touches the new note', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/b.md': '# Note B\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return files[(args as { path: string }).path]
        }
        if (command === 'note_write') {
          const { path: writePath, contents } = args as { path: string; contents: string }
          files[writePath] = contents
          return null
        }
        if (command === 'db_query') {
          const sql = String((args as { sql: string }).sql)
          return sql.includes('"links"') ? [{ source_path: 'notes/src.md' }] : []
        }
        return null
      })

      // Note A: edit the title, save lands, rename pending.
      const paneA = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => paneA.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      paneA.unmount() // teardown settles A's rename asynchronously

      // Note B mounts immediately — the rename must not be able to see it.
      const paneB = renderHook(() => useNoteDocument('notes/b.md', 1, { trackRenames: true }))
      await act(() => vi.runAllTimersAsync())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      expect(files['notes/a.md']).toContain('aliases:') // alias on A, via disk
      expect(files['notes/b.md']).toBe('# Note B\n') // B untouched
      paneB.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a title collision skips both the rewrite and the alias', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return files[(args as { path: string }).path]
        }
        if (command === 'note_write') {
          const { path: writePath, contents } = args as { path: string; contents: string }
          files[writePath] = contents
          return null
        }
        if (command === 'db_query') {
          const sql = String((args as { sql: string }).sql)
          if (sql.includes('"links"')) {
            return [{ source_path: 'notes/src.md' }]
          }
          if (sql.includes('title_key')) {
            return [{ path: 'notes/other-owner.md' }] // another note owns "Old Title"
          }
          return []
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await act(() => vi.runAllTimersAsync())

      // Links keep resolving to their deliberate target; no competing alias.
      expect(files['notes/src.md']).toBe('see [[Old Title]]\n')
      expect(files['notes/a.md']).toBe('# New Title\n')
      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('quit-time flushAllNotes settles a pending rename before resolving', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return files[(args as { path: string }).path]
        }
        if (command === 'note_write') {
          const { path: writePath, contents } = args as { path: string; contents: string }
          files[writePath] = contents
          return null
        }
        if (command === 'db_query') {
          const sql = String((args as { sql: string }).sql)
          return sql.includes('"links"') ? [{ source_path: 'notes/src.md' }] : []
        }
        return null
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // save lands, quiet timer armed

      // ⌘Q: the registry flush must settle the rename and await its writes.
      await act(() => flushAllNotes())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      expect(files['notes/a.md']).toContain('aliases:')
      hook.unmount()
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

  it('lazy notes open empty when missing and are created by the first save', async () => {
    vi.useFakeTimers()
    try {
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          throw { kind: 'notFound', message: 'missing' } // AppError shape
        }
        if (command === 'note_write') {
          disk = (args as { contents: string }).contents
          writes.push(disk)
          return null
        }
        return null
      })

      const hook = renderHook(() =>
        useNoteDocument('daily/2026-06-09.md', 1, { createIfMissing: true }),
      )
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')
      expect(hook.result.current.initialContent).toBe('')
      expect(hook.result.current.dirty).toBe(false)
      expect(writes).toEqual([]) // opening alone never creates the file

      act(() => hook.result.current.onEditorChange('first keystroke\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(writes).toEqual(['first keystroke\n'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a missing non-lazy note is still an error', async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'note_read') {
        throw { kind: 'notFound', message: 'missing' }
      }
      return null
    })
    const hook = renderHook(() => useNoteDocument('notes/gone.md', 1))
    await waitFor(() => expect(hook.result.current.status).toBe('error'))
  })

  it('a same-graph generation bump keeps unsaved edits and saves with the new generation', async () => {
    vi.useFakeTimers()
    try {
      const written: Array<{ contents: string; generation: number }> = []
      mockInvoke.mockImplementation(async (command, args) => {
        if (command === 'note_read') {
          return disk
        }
        if (command === 'note_write') {
          const { contents, generation } = args as { contents: string; generation: number }
          written.push({ contents, generation })
          return null
        }
        return null
      })

      const hook = renderHook(({ gen }) => useNoteDocument('notes/a.md', gen), {
        initialProps: { gen: 1 },
      })
      await act(() => vi.advanceTimersByTimeAsync(0))

      // Reopening the same graph bumps the generation without remounting the
      // pane. The dirty buffer must survive (no dispose/reload-from-disk) and
      // the pending save must carry the NEW generation — a stale one would be
      // rejected by Rust and the edit silently lost.
      act(() => hook.result.current.onEditorChange('# Unsaved\n'))
      hook.rerender({ gen: 2 })
      expect(hook.result.current.dirty).toBe(true)

      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(written).toEqual([{ contents: '# Unsaved\n', generation: 2 }])
      expect(hook.result.current.dirty).toBe(false)
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
