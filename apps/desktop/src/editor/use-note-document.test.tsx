import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { onNoteMoved } from '@/lib/note-moves'
import { flushOpenDocuments } from './open-documents'
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
    insertMarkdown: () => {},
    focus: () => {},
    setSelection: () => {},
    getSelectedText: () => '',
    openSelectionMenu: () => {},
    startPendingReplacement: () => false,
    appendPendingReplacementText: () => {},
    acceptPendingReplacement: () => {},
    discardPendingReplacement: () => {},
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

interface GraphFakeOptions {
  files: Record<string, string>
  /** Rows for the rewrite's `links` source query; may throw to simulate failure. */
  linkSources?: () => Array<{ source_path: string }>
  /** Path returned by title resolution (simulates a title collision). */
  resolveTitleTo?: string
}

/** One bridge fake for the rename scenarios: a files map + the index queries. */
function installGraphFake({ files, linkSources, resolveTitleTo }: GraphFakeOptions) {
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      const content = files[(args as { path: string }).path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'missing' }
      }
      return content
    }
    if (command === 'note_write') {
      const { path: writePath, contents } = args as { path: string; contents: string }
      files[writePath] = contents
      return null
    }
    if (command === 'db_query') {
      const sql = String((args as { sql: string }).sql)
      if (sql.includes('"links"')) {
        return linkSources ? linkSources() : []
      }
      if (resolveTitleTo !== undefined && sql.includes('title_key')) {
        return [{ path: resolveTitleTo }]
      }
      return []
    }
    if (command === 'note_exists') {
      return files[(args as { path: string }).path] !== undefined
    }
    if (command === 'note_move_indexed') {
      const { from, to } = args as { from: string; to: string }
      // Mirrors the Rust command for the paths these tests exercise: a free
      // destination renames (occupied ones refuse, but no test stages that).
      if (files[to] === undefined && files[from] !== undefined) {
        files[to] = files[from]
      }
      delete files[from]
      return null
    }
    return null
  })
  return files
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

  it('flushOpenDocuments persists a pending edit without waiting out the debounce (quit path)', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useNoteDocument('notes/a.md', 1))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      act(() => hook.result.current.onEditorChange('# Quitting\n'))
      expect(writes).toEqual([]) // still inside the 800ms debounce window

      // The quit path: the registry flush settles only once the write has
      // landed — no timer advance, the way a ⌘Q teardown would run it.
      await act(() => flushOpenDocuments())
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

    await flushOpenDocuments() // the unmounted buffer must no longer be registered
    expect(writes.length).toBe(writesAfterUnmount)
  })

  it('a settled title change rewrites inbound links and records the alias (Plan 07b)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

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
      // The file followed its title (Plan 17): alias and content move along.
      expect(files['notes/a.md']).toBeUndefined()
      expect(files['notes/new-title.md']).toContain('aliases:')
      expect(files['notes/new-title.md']).toContain('Old Title')
      expect(files['notes/new-title.md']!.endsWith('# New Title\n')).toBe(true)
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
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // save lands, quiet timer armed

      hook.unmount() // teardown settles the tracker — the session is disposed
      await act(() => vi.runAllTimersAsync())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      // The alias can't go through the disposed session — it lands on disk,
      // and the move then carries it to the slug path.
      expect(files['notes/new-title.md']).toContain('aliases:')
      expect(files['notes/new-title.md']).toContain('Old Title')
      expect(files['notes/a.md']).toBeUndefined()
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
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

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
      expect(files['notes/new-title.md']).toContain('aliases:') // alias on A, via disk
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
      installGraphFake({
        files,
        linkSources: () => [{ source_path: 'notes/src.md' }],
        resolveTitleTo: 'notes/other-owner.md', // another note owns "Old Title"
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
      // The file still follows the NEW title — the guard is about the old
      // title's links, not the filename.
      expect(files['notes/src.md']).toBe('see [[Old Title]]\n')
      expect(files['notes/new-title.md']).toBe('# New Title\n')
      expect(files['notes/a.md']).toBeUndefined()
      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed rewrite still records the alias (the resolve safety net)', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({
        files,
        linkSources: () => {
          throw new Error('index unavailable') // the rewrite cannot run
        },
      })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await act(() => vi.runAllTimersAsync())

      // The rewrite failed, the baseline has advanced — the alias is what
      // keeps [[Old Title]] resolving here, so it must land regardless.
      expect(files['notes/src.md']).toBe('see [[Old Title]]\n')
      expect(files['notes/new-title.md']).toContain('aliases:')
      expect(files['notes/new-title.md']).toContain('Old Title')
      hook.unmount()
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('a lazy note\u2019s first heading never fires a rename', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/src.md': 'unrelated\n',
      }
      const linkQueries: string[] = []
      installGraphFake({
        files,
        linkSources: () => {
          linkQueries.push('sources-query')
          return []
        },
      })

      const hook = renderHook(() =>
        useNoteDocument('notes/01arz3ndekt.md', 1, {
          createIfMissing: true,
          trackRenames: true,
        }),
      )
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      act(() => hook.result.current.onEditorChange('# Brand New Note\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await act(() => vi.runAllTimersAsync())

      // Titling an untitled note is a birth: no rewrite ran, no alias landed —
      // but the file shed its placeholder name for the title's slug (Plan 17).
      expect(linkQueries).toEqual([])
      expect(files['notes/brand-new-note.md']).toBe('# Brand New Note\n')
      expect(files['notes/01arz3ndekt.md']).toBeUndefined()
      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the pane adopts its retargeted session when the route follows a move (Plan 17)', async () => {
    vi.useFakeTimers()
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => moves.push([from, to]))
    try {
      const files: Record<string, string> = { 'notes/a.md': '# Old Title\n' }
      installGraphFake({ files })

      const hook = renderHook(
        ({ path }: { path: string }) => useNoteDocument(path, 1, { trackRenames: true }),
        { initialProps: { path: 'notes/a.md' } },
      )
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')
      const epochBefore = hook.result.current.sessionEpoch

      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // save lands
      await act(() => vi.runAllTimersAsync()) // quiet period → rename + move

      expect(moves).toEqual([['notes/a.md', 'notes/new-title.md']])
      // Alias frontmatter (the rename's breadcrumb) + content, at the slug path.
      expect(files['notes/new-title.md']).toContain('Old Title')
      expect(files['notes/new-title.md']).toContain('# New Title\n')
      expect(files['notes/a.md']).toBeUndefined()

      // The router (subscribed to onNoteMoved) re-renders the pane with the
      // new path; the hook adopts the retargeted session — no reload, no new
      // epoch, so the live editor (and its cursor) survives.
      hook.rerender({ path: 'notes/new-title.md' })
      await act(async () => {})
      expect(hook.result.current.status).toBe('ready')
      expect(hook.result.current.sessionEpoch).toBe(epochBefore)

      // Subsequent edits land on the new path only — nothing resurrects a.md.
      act(() => hook.result.current.onEditorChange('# New Title\n\nmore\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      expect(files['notes/new-title.md']).toContain('# New Title\n\nmore\n')
      expect(files['notes/a.md']).toBeUndefined()
      hook.unmount()
    } finally {
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('watcher upserts at the retargeted path reconcile before React catches up (Plan 17)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = { 'notes/a.md': '# Old Title\n' }
      installGraphFake({ files })
      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      await act(() => vi.runAllTimersAsync()) // rename + move settle; session retargeted

      // An external edit lands at the NEW path while the pane still renders
      // the old route path (no rerender yet) — it must reconcile against the
      // session's current path, not the stale prop.
      files['notes/new-title.md'] = '# New Title\n\nedited elsewhere\n'
      act(() => {
        emitChange?.([{ path: 'notes/new-title.md', kind: 'upsert' }])
      })
      await act(() => vi.runAllTimersAsync())

      expect(hook.result.current.initialContent).toContain('edited elsewhere')
      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unadopted retargeted session still tears down on unmount (no orphan flush)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = { 'notes/a.md': '# Old Title\n' }
      installGraphFake({ files })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      await act(() => vi.runAllTimersAsync()) // move lands; session retargeted

      // Unmount without any rerender (nothing adopted the session): the
      // deferred teardown must still dispose it and flush nothing stale.
      hook.unmount()
      await act(async () => {})
      const after = { ...files }

      await flushOpenDocuments() // an orphan would flush here and resurrect a.md
      expect(files).toEqual(after)
      expect(files['notes/a.md']).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('alias placement preserves aliases gained while the rewrite ran', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))

      hook.unmount() // teardown settle → the alias lands via the disk path
      // An external writer adds an alias before the chain's placement read —
      // the settle-time snapshot doesn't know about it.
      files['notes/a.md'] = '---\naliases:\n  - Keeper\n---\n# New Title\n'
      await act(() => vi.runAllTimersAsync())

      expect(files['notes/new-title.md']).toContain('Keeper') // concurrently-gained, kept
      expect(files['notes/new-title.md']).toContain('Old Title') // the rename's alias
    } finally {
      vi.useRealTimers()
    }
  })

  it('a teardown rename routes its alias through a reopened dirty session', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const paneA = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => paneA.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000))
      paneA.unmount() // settles the rename; its chain runs on

      // The same note is reopened immediately and edited before the chain's
      // alias placement runs.
      const paneA2 = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => paneA2.result.current.onEditorChange('# New Title\n\nfresh edit\n'))
      await act(() => vi.runAllTimersAsync())

      // The alias went through the live session — no conflict from our own
      // background write, and the user's edit and the alias both persist
      // (carried to the slug path by the move).
      expect(paneA2.result.current.conflict).toBeNull()
      expect(files['notes/new-title.md']).toContain('aliases:')
      expect(files['notes/new-title.md']).toContain('Old Title')
      expect(files['notes/new-title.md']).toContain('fresh edit')
      paneA2.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('quit-time flushOpenDocuments settles a pending rename before resolving', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': '# Old Title\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await act(() => vi.advanceTimersByTimeAsync(0))
      act(() => hook.result.current.onEditorChange('# New Title\n'))
      await act(() => vi.advanceTimersByTimeAsync(1000)) // save lands, quiet timer armed

      // ⌘Q: the registry flush must settle the rename and await its writes.
      await act(() => flushOpenDocuments())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      expect(files['notes/new-title.md']).toContain('aliases:')
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
      // meowdown's converter mangles git conflict markers, so the guard must catch it.
      disk =
        '# Shared\n\n<<<<<<< this device\nedited on a\n=======\nedited on b\n>>>>>>> other device\n'
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
