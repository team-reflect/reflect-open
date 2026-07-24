import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { setBridge, upsertFrontmatter } from '@reflect/core'
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

const MANAGED_ID = '01hv3xq7c2dm8k4t9w5e6r1n98'

function managedNote(content: string): string {
  return upsertFrontmatter(content, { id: MANAGED_ID })
}

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
  const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
  await vi.waitFor(() => expect(hook.result.current.status).toBe('ready'))
  return hook
}

interface GraphFakeOptions {
  files: Record<string, string>
  /** Rows for the rewrite's `links` source query; may throw to simulate failure. */
  linkSources?: () => Array<{ source_path: string }>
  /** Path returned by title resolution (simulates a title collision). */
  resolveTitleTo?: string
}

/**
 * Hold the IPC calls matching `match` until the returned release runs, so a
 * background chain can be parked mid-flight. The browser-mode `unmount()`
 * awaits React's act (it flushes microtasks), which would otherwise run a
 * teardown chain to completion before the test can stage the next step.
 */
function gateInvokes(match: (command: string, args: Record<string, unknown>) => boolean) {
  const ungated = mockInvoke.getMockImplementation()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  mockInvoke.mockImplementation(async (command, args) => {
    if (match(command, args)) {
      await gate
    }
    return ungated?.(command, args)
  })
  return release
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
      if (resolveTitleTo !== undefined && sql.includes('note_keys')) {
        return [{ note_path: resolveTitleTo }]
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
      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      await hook.act(() => hook.result.current.onEditorChange('# Hello edited\n'))
      expect(hook.result.current.dirty).toBe(true)
      expect(writes).toEqual([])

      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      expect(writes).toEqual(['# Hello edited\n'])
      expect(hook.result.current.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushOpenDocuments persists a pending edit without waiting out the debounce (quit path)', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      await hook.act(() => hook.result.current.onEditorChange('# Quitting\n'))
      expect(writes).toEqual([]) // still inside the 800ms debounce window

      // The quit path: the registry flush settles only once the write has
      // landed — no timer advance, the way a ⌘Q teardown would run it.
      await hook.act(() => flushOpenDocuments())
      expect(writes).toEqual(['# Quitting\n'])
      expect(hook.result.current.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles pending editor input before the editor handle unbinds', async () => {
    const hook = await readyHook()
    const editor = fakeEditor()
    const getMarkdown = vi.fn(() => {
      hook.result.current.onEditorChange('# 🧠 Business ideas\n')
      return '# 🧠 Business ideas\n'
    })
    editor.getMarkdown = getMarkdown

    await hook.act(() => hook.result.current.bindEditor(editor))
    await hook.act(() => hook.result.current.bindEditor(null))
    await hook.act(() => flushOpenDocuments())

    expect(getMarkdown).toHaveBeenCalledOnce()
    expect(writes).toEqual(['# 🧠 Business ideas\n'])
    await hook.unmount()
  })

  it('unmounting unregisters the buffer from the quit-flush registry', async () => {
    const hook = await readyHook()
    await hook.act(() => hook.result.current.onEditorChange('# Edited\n'))
    await hook.unmount() // unmount itself flushes once (the existing final-flush path)
    await hook.act(async () => {})
    const writesAfterUnmount = writes.length

    await flushOpenDocuments() // the unmounted buffer must no longer be registered
    expect(writes.length).toBe(writesAfterUnmount)
  })

  it('a settled title change rewrites inbound links and records the alias (Plan 07b)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000)) // the rename save lands

      // Blur is a settle point: the rewrite fires without waiting out the
      // quiet period, then the alias lands through the normal save pipeline.
      await hook.act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await hook.act(() => vi.runAllTimersAsync())

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
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000)) // save lands, quiet timer armed

      await hook.unmount() // teardown settles the tracker — the session is disposed
      await hook.act(() => vi.runAllTimersAsync())

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
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/b.md': '# Note B\n',
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      // Note A: edit the title, save lands, rename pending.
      const paneA = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await paneA.act(() => vi.advanceTimersByTimeAsync(0))
      await paneA.act(() => paneA.result.current.onEditorChange('# New Title\n'))
      await paneA.act(() => vi.advanceTimersByTimeAsync(1000))
      await paneA.unmount() // teardown settles A's rename asynchronously

      // Note B mounts immediately — the rename must not be able to see it.
      const paneB = await renderHook(() => useNoteDocument('notes/b.md', 1, { trackRenames: true }))
      await paneB.act(() => vi.runAllTimersAsync())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      expect(files['notes/new-title.md']).toContain('aliases:') // alias on A, via disk
      expect(files['notes/b.md']).toBe('# Note B\n') // B untouched
      await paneB.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a title collision skips both the rewrite and the alias', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({
        files,
        linkSources: () => [{ source_path: 'notes/src.md' }],
        resolveTitleTo: 'notes/other-owner.md', // another note owns "Old Title"
      })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await hook.act(() => vi.runAllTimersAsync())

      // Links keep resolving to their deliberate target; no competing alias.
      // The file still follows the NEW title — the guard is about the old
      // title's links, not the filename.
      expect(files['notes/src.md']).toBe('see [[Old Title]]\n')
      expect(files['notes/new-title.md']).toContain(`id: ${MANAGED_ID}`)
      expect(files['notes/new-title.md']!.endsWith('# New Title\n')).toBe(true)
      expect(files['notes/a.md']).toBeUndefined()
      await hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed rewrite still records the alias (the resolve safety net)', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const files: Record<string, string> = {
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({
        files,
        linkSources: () => {
          throw new Error('index unavailable') // the rewrite cannot run
        },
      })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await hook.act(() => vi.runAllTimersAsync())

      // The rewrite failed, the baseline has advanced — the alias is what
      // keeps [[Old Title]] resolving here, so it must land regardless.
      expect(files['notes/src.md']).toBe('see [[Old Title]]\n')
      expect(files['notes/new-title.md']).toContain('aliases:')
      expect(files['notes/new-title.md']).toContain('Old Title')
      await hook.unmount()
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

      const placeholderPath = 'notes/01arz3ndektsv4rrffq69g5fav.md'
      const hook = await renderHook(() =>
        useNoteDocument(placeholderPath, 1, {
          createIfMissing: true,
          trackRenames: true,
          missingSeed: managedNote('#\n'),
        }),
      )
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      await hook.act(() => hook.result.current.onEditorChange('# Brand New Note\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await hook.act(() => vi.runAllTimersAsync())

      // Titling an untitled note is a birth: no rewrite ran, no alias landed —
      // but the file shed its placeholder name for the title's slug (Plan 17).
      expect(linkQueries).toEqual([])
      expect(files['notes/brand-new-note.md']).toContain(`id: ${MANAGED_ID}`)
      expect(files['notes/brand-new-note.md']!.endsWith('# Brand New Note\n')).toBe(true)
      expect(files[placeholderPath]).toBeUndefined()
      await hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('maintains links for an adopted retitle without moving its file', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/adopted.md': '# Old Title\n',
        'notes/source.md': 'see [[Old Title]]\n',
      }
      const linkQueries: string[] = []
      installGraphFake({
        files,
        linkSources: () => {
          linkQueries.push('sources-query')
          return [{ source_path: 'notes/source.md' }]
        },
      })

      const hook = await renderHook(() =>
        useNoteDocument('notes/adopted.md', 1, { trackRenames: true }),
      )
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      await hook.act(() => vi.runAllTimersAsync())

      expect(files['notes/adopted.md']).toBe(
        upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] }),
      )
      expect(files['notes/new-title.md']).toBeUndefined()
      expect(files['notes/source.md']).toBe('see [[New Title]]\n')
      expect(linkQueries).toEqual(['sources-query'])
      await hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the pane adopts its retargeted session when the route follows a move (Plan 17)', async () => {
    vi.useFakeTimers()
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => moves.push([from, to]))
    try {
      const files: Record<string, string> = { 'notes/a.md': managedNote('# Old Title\n') }
      installGraphFake({ files })

      const hook = await renderHook(
        ({ path }: { path: string } = { path: 'notes/a.md' }) => useNoteDocument(path, 1, { trackRenames: true }),
        { initialProps: { path: 'notes/a.md' } },
      )
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')
      const epochBefore = hook.result.current.sessionEpoch

      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000)) // save lands
      await hook.act(() => vi.runAllTimersAsync()) // quiet period → rename + move

      expect(moves).toEqual([['notes/a.md', 'notes/new-title.md']])
      // Alias frontmatter (the rename's breadcrumb) + content, at the slug path.
      expect(files['notes/new-title.md']).toContain('Old Title')
      expect(files['notes/new-title.md']).toContain('# New Title\n')
      expect(files['notes/a.md']).toBeUndefined()

      // The router (subscribed to onNoteMoved) re-renders the pane with the
      // new path; the hook adopts the retargeted session — no reload, no new
      // epoch, so the live editor (and its cursor) survives.
      await hook.rerender({ path: 'notes/new-title.md' })
      await hook.act(async () => {})
      expect(hook.result.current.status).toBe('ready')
      expect(hook.result.current.sessionEpoch).toBe(epochBefore)

      // Subsequent edits land on the new path only — nothing resurrects a.md.
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n\nmore\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      expect(files['notes/new-title.md']).toContain('# New Title\n\nmore\n')
      expect(files['notes/a.md']).toBeUndefined()
      await hook.unmount()
    } finally {
      unsubscribe()
      vi.useRealTimers()
    }
  })

  it('watcher upserts at the retargeted path reconcile before React catches up (Plan 17)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = { 'notes/a.md': managedNote('# Old Title\n') }
      installGraphFake({ files })
      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => vi.runAllTimersAsync()) // rename + move settle; session retargeted

      // An external edit lands at the NEW path while the pane still renders
      // the old route path (no rerender yet) — it must reconcile against the
      // session's current path, not the stale prop.
      files['notes/new-title.md'] = '# New Title\n\nedited elsewhere\n'
      await hook.act(() => {
        emitChange?.([{ path: 'notes/new-title.md', kind: 'upsert' }])
      })
      await hook.act(() => vi.runAllTimersAsync())

      expect(hook.result.current.initialContent).toContain('edited elsewhere')
      await hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unadopted retargeted session still tears down on unmount (no orphan flush)', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = { 'notes/a.md': managedNote('# Old Title\n') }
      installGraphFake({ files })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => vi.runAllTimersAsync()) // move lands; session retargeted

      // Unmount without any rerender (nothing adopted the session): the
      // deferred teardown must still dispose it and flush nothing stale.
      await hook.unmount()
      await hook.act(async () => {})
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
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))

      const teardown = hook.unmount() // teardown settle → the alias lands via the disk path
      // An external writer adds an alias before the chain's placement read —
      // the settle-time snapshot doesn't know about it. The write has to land
      // before the unmount promise flushes the chain's continuation.
      files['notes/a.md'] = '---\naliases:\n  - Keeper\n---\n# New Title\n'
      await teardown
      await hook.act(() => vi.runAllTimersAsync())

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
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const paneA = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await paneA.act(() => vi.advanceTimersByTimeAsync(0))
      await paneA.act(() => paneA.result.current.onEditorChange('# New Title\n'))
      await paneA.act(() => vi.advanceTimersByTimeAsync(1000))
      // Park the chain at its link rewrite so the reopen lands first, the way
      // it does in the app.
      const releaseRewrite = gateInvokes(
        (command, args) => command === 'note_write' && args['path'] === 'notes/src.md',
      )
      await paneA.unmount() // settles the rename; its chain runs on

      // The same note is reopened immediately and edited before the chain's
      // alias placement runs.
      const paneA2 = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await paneA2.act(() => vi.advanceTimersByTimeAsync(0))
      await paneA2.act(() => paneA2.result.current.onEditorChange('# New Title\n\nfresh edit\n'))
      releaseRewrite()
      await paneA2.act(() => vi.runAllTimersAsync())

      // The alias went through the live session — no conflict from our own
      // background write, and the user's edit and the alias both persist
      // (carried to the slug path by the move).
      expect(paneA2.result.current.conflict).toBeNull()
      expect(files['notes/new-title.md']).toContain('aliases:')
      expect(files['notes/new-title.md']).toContain('Old Title')
      expect(files['notes/new-title.md']).toContain('fresh edit')
      await paneA2.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('quit-time flushOpenDocuments settles a pending rename before resolving', async () => {
    vi.useFakeTimers()
    try {
      const files: Record<string, string> = {
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      }
      installGraphFake({ files, linkSources: () => [{ source_path: 'notes/src.md' }] })

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1, { trackRenames: true }))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000)) // save lands, quiet timer armed

      // ⌘Q: the registry flush must settle the rename and await its writes.
      await hook.act(() => flushOpenDocuments())

      expect(files['notes/src.md']).toBe('see [[New Title]]\n')
      expect(files['notes/new-title.md']).toContain('aliases:')
      await hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores the watcher echo of its own save', async () => {
    const { result, act } = await readyHook()
    const editor = fakeEditor()
    await act(() => result.current.bindEditor(editor))

    // The watcher reports our own write back; content matches disk state.
    await act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await act(async () => {})
    expect(editor.applied).toEqual([])
    expect(result.current.conflict).toBeNull()
  })

  it('reloads a clean buffer on a real external change', async () => {
    const { result, act } = await readyHook()
    const editor = fakeEditor()
    await act(() => result.current.bindEditor(editor))

    disk = '# Changed outside\n'
    await act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await vi.waitFor(() => expect(editor.applied).toEqual(['# Changed outside\n']))
    expect(result.current.conflict).toBeNull()
    expect(result.current.dirty).toBe(false)
  })

  it('parks an external change as a conflict when the buffer is dirty', async () => {
    const { result, act } = await readyHook()
    const editor = fakeEditor()
    await act(() => result.current.bindEditor(editor))

    await act(() => result.current.onEditorChange('# My unsaved edit\n'))
    disk = '# Theirs\n'
    await act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await vi.waitFor(() => expect(result.current.conflict).toBe('# Theirs\n'))
    expect(editor.applied).toEqual([]) // never clobbered

    // Load theirs: applies the external content and clears the conflict.
    await act(() => result.current.loadTheirs())
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
      const hook = await renderHook(() => useNoteDocument('notes/tasks.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')
      expect(hook.result.current.protected).toBe(true)

      // Even if an edit somehow reaches the pipeline, nothing is written.
      await hook.act(() => hook.result.current.onEditorChange('mangled'))
      await hook.act(() => vi.advanceTimersByTimeAsync(2000))
      expect(writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an external reload never dirties the buffer, even when serialization normalizes', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      // The editor's change handler fires synchronously inside setMarkdown and
      // reports a *normalized* serialization (extra trailing newline) — as the
      // real editor does for e.g. loose lists.
      const editor = fakeEditor()
      let normalizedMarkdown = ''
      const normalizing: typeof editor = {
        ...editor,
        getMarkdown: () => normalizedMarkdown,
        setMarkdown: (markdown) => {
          editor.setMarkdown(markdown)
          normalizedMarkdown = `${markdown}\n`
          hook.result.current.onEditorChange(normalizedMarkdown)
        },
      }
      await hook.act(() => hook.result.current.bindEditor(normalizing))

      disk = '# Changed outside\n'
      await hook.act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(editor.applied).toEqual(['# Changed outside\n'])
      expect(hook.result.current.dirty).toBe(false)

      // No save may fire from the reload alone.
      await hook.act(() => vi.advanceTimersByTimeAsync(5000))
      expect(writes).toEqual([])

      // A persistence flush and ref teardown both ask Meowdown to reconcile,
      // but its unchanged normalized snapshot is not itself a user edit.
      await hook.act(() => flushOpenDocuments())
      await hook.act(() => hook.result.current.bindEditor(null))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses saves while a conflict is parked (no clobbering theirs)', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      // An edit schedules a save, then an external change parks a conflict
      // before the debounce fires.
      await hook.act(() => hook.result.current.onEditorChange('# Mine\n'))
      disk = '# Theirs\n'
      await hook.act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.conflict).toBe('# Theirs\n')

      // Neither the pending debounce nor an explicit flush may write now.
      await hook.act(() => hook.result.current.onEditorChange('# Mine v2\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(5000))
      expect(writes).toEqual([])

      // Resolution unblocks: keepMine rewrites with the buffer.
      await hook.act(() => hook.result.current.keepMine())
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
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

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      await hook.act(() => hook.result.current.onEditorChange('# Saved\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000)) // write dispatched, unresolved
      expect(writes).toEqual(['# Saved\n'])

      // User keeps typing (dirty again) while the watcher reports our write.
      await hook.act(() => hook.result.current.onEditorChange('# Saved and more\n'))
      await hook.act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.conflict).toBeNull() // echo, not a conflict

      await hook.act(() => {
        resolveWrite?.()
      })
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
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

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      await hook.act(() => hook.result.current.onEditorChange('# A\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000)) // write1(A) dispatched, hanging
      expect(writes).toEqual(['# A\n'])

      // More typing queues a second save; then the user reverts to A before
      // write1 settles. The queued step must NOT persist the stale "# B".
      await hook.act(() => hook.result.current.onEditorChange('# B\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      await hook.act(() => hook.result.current.onEditorChange('# A\n'))
      await hook.act(() => {
        resolveWrite?.()
      })
      await hook.act(() => vi.advanceTimersByTimeAsync(2000))
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

      const hook = await renderHook(() => useNoteDocument('notes/a.md', 1))
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      await hook.act(() => hook.result.current.onEditorChange('# Edited\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      expect(hook.result.current.error).toMatch(/disk full/)
      expect(hook.result.current.status).toBe('ready') // editing continues

      // The next (successful) save clears the surfaced error.
      await hook.act(() => hook.result.current.onEditorChange('# Edited again\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
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

      const hook = await renderHook(({ path }: { path: string } = { path: 'notes/a.md' }) => useNoteDocument(path, 1), {
        initialProps: { path: 'notes/a.md' },
      })
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      // Dirty edit, then switch notes before the debounce fires: the unmount
      // flush must persist the OLD note's buffer to the OLD path.
      await hook.act(() => hook.result.current.onEditorChange('# Unsaved on A\n'))
      await hook.rerender({ path: 'notes/b.md' })
      await hook.act(() => vi.advanceTimersByTimeAsync(2000))

      expect(written).toContainEqual({ path: 'notes/a.md', contents: '# Unsaved on A\n' })
      expect(written.some((write) => write.path === 'notes/b.md')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles pending editor input during a same-path session rebind', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook(
        ({ createIfMissing }: { createIfMissing: boolean } = { createIfMissing: false }) =>
          useNoteDocument('notes/a.md', 1, { createIfMissing }),
        { initialProps: { createIfMissing: false } },
      )
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')

      const editor = fakeEditor()
      let reconciled = false
      editor.getMarkdown = vi.fn(() => {
        if (!reconciled) {
          reconciled = true
          hook.result.current.onEditorChange('# Pending native input\n')
        }
        return '# Pending native input\n'
      })
      await hook.act(() => hook.result.current.bindEditor(editor))

      // Changing a session option recreates the session without unmounting the
      // editor. The outgoing session must remain discoverable while Meowdown
      // synchronously reports reconciled native input from getMarkdown().
      await hook.rerender({ createIfMissing: true })
      await hook.act(() => vi.advanceTimersByTimeAsync(2000))

      expect(editor.getMarkdown).toHaveBeenCalled()
      expect(writes).toContain('# Pending native input\n')
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

      const hook = await renderHook(() =>
        useNoteDocument('daily/2026-06-09.md', 1, { createIfMissing: true }),
      )
      await hook.act(() => vi.advanceTimersByTimeAsync(0))
      expect(hook.result.current.status).toBe('ready')
      expect(hook.result.current.initialContent).toBe('')
      expect(hook.result.current.dirty).toBe(false)
      expect(writes).toEqual([]) // opening alone never creates the file

      await hook.act(() => hook.result.current.onEditorChange('first keystroke\n'))
      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
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
    const hook = await renderHook(() => useNoteDocument('notes/gone.md', 1))
    await vi.waitFor(() => expect(hook.result.current.status).toBe('error'))
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

      const hook = await renderHook(({ gen }: { gen: number } = { gen: 1 }) => useNoteDocument('notes/a.md', gen), {
        initialProps: { gen: 1 },
      })
      await hook.act(() => vi.advanceTimersByTimeAsync(0))

      // Reopening the same graph bumps the generation without remounting the
      // pane. The dirty buffer must survive (no dispose/reload-from-disk) and
      // the pending save must carry the NEW generation — a stale one would be
      // rejected by Rust and the edit silently lost.
      await hook.act(() => hook.result.current.onEditorChange('# Unsaved\n'))
      await hook.rerender({ gen: 2 })
      expect(hook.result.current.dirty).toBe(true)

      await hook.act(() => vi.advanceTimersByTimeAsync(1000))
      expect(written).toEqual([{ contents: '# Unsaved\n', generation: 2 }])
      expect(hook.result.current.dirty).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keepMine rewrites the file with the buffer', async () => {
    const { result, act } = await readyHook()
    await act(() => result.current.onEditorChange('# My unsaved edit\n'))
    disk = '# Theirs\n'
    await act(() => emitChange?.([{ path: 'notes/a.md', kind: 'upsert' }]))
    await vi.waitFor(() => expect(result.current.conflict).toBe('# Theirs\n'))

    await act(() => result.current.keepMine())
    await vi.waitFor(() => expect(writes).toContain('# My unsaved edit\n'))
    expect(result.current.conflict).toBeNull()
  })
})
