import { beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertFrontmatter, type FileChange } from '@reflect/core'
import {
  createTestCoreServices,
  createTestClockService,
  createTestIndexStoreService,
  createTestLoggerService,
  createTestNoteFileService,
  seedNotes,
  type TestClockService,
  type TestDatabaseService,
  type TestLoggerService,
  type TestNoteFileService,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import type { NoteEditorHandle } from './note-editor.tsx'
import { useNoteDocument } from './use-note-document.ts'

/**
 * Runs the save debounce and the rename quiet period.
 */
let clock: TestClockService
let logger: TestLoggerService
/**
 * The files of the graph, with a log of every write.
 */
let noteFile: TestNoteFileService
let app: ReturnType<typeof createApp>

/**
 * Run every pending timer, and the timers those arm.
 */
async function runAllTimers(): Promise<void> {
  await clock.advance(60_000)
}

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
    findNext: () => {},
    findPrevious: () => {},
  }
}

/**
 * The app of one test: the real document services over `noteFile`, `clock` and `logger`.
 */
function createApp(database: TestDatabaseService) {
  const indexStore = createTestIndexStoreService()
  const moveIndexed = indexStore.moveIndexed.bind(indexStore)
  // Mirrors the Rust command for the paths these tests exercise: a free
  // destination renames (occupied ones refuse, but no test stages that).
  vi.spyOn(indexStore, 'moveIndexed').mockImplementation(async (from, to, generation) => {
    const contents = noteFile.files().get(from)
    if (contents !== undefined && !noteFile.files().has(to)) {
      noteFile.set(to, contents)
    }
    await noteFile.delete(from, generation)
    await moveIndexed(from, to, generation)
  })
  return createTestCoreServices({
    clock,
    logger,
    database,
    noteFile,
    indexStore,
  })
}

beforeEach(async () => {
  clock = createTestClockService()
  logger = createTestLoggerService()
  noteFile = createTestNoteFileService({ files: { 'notes/a.md': '# Hello\n' } })
  // Opened here, so every index read of a rename settles in microtasks.
  app = createApp(await createWasmTestDatabaseService())
})

/**
 * Render `hook` in the app of the running test, whose graph is open on generation 1.
 */
function mount<Result, Props = undefined>(
  hook: (props?: Props) => Result,
  options?: { initialProps: Props },
) {
  return renderHookInApp(hook, { app, ...options })
}

/**
 * The contents of every note write so far, in order.
 */
function writes(): string[] {
  return noteFile.writes().map((write) => write.contents)
}

/**
 * The current contents of `path`, or `undefined` when no such file exists.
 */
function file(path: string): string | undefined {
  return noteFile.files().get(path)
}

/**
 * Deliver watcher changes to the open documents, and let the reads they start settle.
 */
async function emitChange(changes: FileChange[]): Promise<void> {
  app.fileChanges.emit({ changes, source: 'external' })
  // The test doubles answer in microtasks, so one task later nothing is pending.
  await new Promise((resolve) => setTimeout(resolve))
}

async function readyHook() {
  const hook = await mount(() => useNoteDocument('notes/a.md'))
  await vi.waitFor(() => expect(hook.result.current.status).toBe('ready'))
  return hook
}

/**
 * Replace the files of the graph with `files`, and index the notes in `indexed`.
 */
function seedGraph(files: Record<string, string>, indexed: readonly string[] = []): void {
  for (const path of noteFile.files().keys()) {
    void noteFile.delete(path, 1)
  }
  for (const [path, contents] of Object.entries(files)) {
    noteFile.set(path, contents)
  }
  seedNotes(
    app.database,
    indexed.map((path) => ({ path, markdown: files[path] ?? '' })),
  )
}

describe('useNoteDocument', () => {
  it('loads the note and seeds the editor content', async () => {
    const { result } = await readyHook()
    expect(result.current.initialContent).toBe('# Hello\n')
    expect(result.current.dirty).toBe(false)
  })

  it('debounces edits into an atomic write and clears dirty', async () => {
    const hook = await mount(() => useNoteDocument('notes/a.md'))
    await hook.act(() => clock.advance(0))
    expect(hook.result.current.status).toBe('ready')

    await hook.act(() => hook.result.current.onEditorChange('# Hello edited\n'))
    expect(hook.result.current.dirty).toBe(true)
    expect(writes()).toEqual([])

    await hook.act(() => clock.advance(1000))
    expect(writes()).toEqual(['# Hello edited\n'])
    expect(hook.result.current.dirty).toBe(false)
  })

  it('flushOpenDocuments persists a pending edit without waiting out the debounce (quit path)', async () => {
    const hook = await mount(() => useNoteDocument('notes/a.md'))
    await hook.act(() => clock.advance(0))
    expect(hook.result.current.status).toBe('ready')

    await hook.act(() => hook.result.current.onEditorChange('# Quitting\n'))
    expect(writes()).toEqual([]) // still inside the 800ms debounce window

    // The quit path: the registry flush settles only once the write has
    // landed — no timer advance, the way a ⌘Q teardown would run it.
    await hook.act(() => app.openDocuments.flushAll())
    expect(writes()).toEqual(['# Quitting\n'])
    expect(hook.result.current.dirty).toBe(false)
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
    await hook.act(() => app.openDocuments.flushAll())

    expect(getMarkdown).toHaveBeenCalledOnce()
    expect(writes()).toEqual(['# 🧠 Business ideas\n'])
    await hook.unmount()
  })

  it('unmounting unregisters the buffer from the quit-flush registry', async () => {
    const hook = await readyHook()
    await hook.act(() => hook.result.current.onEditorChange('# Edited\n'))
    await hook.unmount() // unmount itself flushes once (the existing final-flush path)
    await hook.act(async () => {})
    const writesAfterUnmount = writes().length

    await app.openDocuments.flushAll() // the unmounted buffer must no longer be registered
    expect(writes().length).toBe(writesAfterUnmount)
  })

  it('a settled title change rewrites inbound links and records the alias (Plan 07b)', async () => {
    seedGraph(
      {
        'notes/a.md': managedNote('# Old Title\n'),
        'notes/src.md': 'see [[Old Title]]\n',
      },
      ['notes/a.md', 'notes/src.md'],
    )

    const hook = await mount(() => useNoteDocument('notes/a.md', { trackRenames: true }))
    await hook.act(() => clock.advance(0))
    expect(hook.result.current.status).toBe('ready')

    await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
    await hook.act(() => clock.advance(1000)) // the rename save lands

    // Blur is a settle point: the rewrite fires without waiting out the
    // quiet period, then the alias lands through the normal save pipeline.
    await hook.act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await hook.act(() => runAllTimers())

    expect(file('notes/src.md')).toBe('see [[New Title]]\n')
    // The file followed its title (Plan 17): alias and content move along.
    expect(file('notes/a.md')).toBeUndefined()
    expect(file('notes/new-title.md')).toContain('aliases:')
    expect(file('notes/new-title.md')).toContain('Old Title')
    expect(file('notes/new-title.md')!.endsWith('# New Title\n')).toBe(true)
  })

  it('the pane adopts its retargeted session when the route follows a move (Plan 17)', async () => {
    seedGraph({ 'notes/a.md': managedNote('# Old Title\n') })

    const hook = await mount(
      ({ path }: { path: string } = { path: 'notes/a.md' }) =>
        useNoteDocument(path, { trackRenames: true }),
      { initialProps: { path: 'notes/a.md' } },
    )
    await hook.act(() => clock.advance(0))
    expect(hook.result.current.status).toBe('ready')
    const epochBefore = hook.result.current.sessionEpoch

    await hook.act(() => hook.result.current.onEditorChange('# New Title\n'))
    await hook.act(() => clock.advance(1000)) // save lands
    await hook.act(() => runAllTimers()) // quiet period → rename + move

    expect(app.noteMove.moved()).toEqual([['notes/a.md', 'notes/new-title.md']])
    // Alias frontmatter (the rename's breadcrumb) + content, at the slug path.
    expect(file('notes/new-title.md')).toContain('Old Title')
    expect(file('notes/new-title.md')).toContain('# New Title\n')
    expect(file('notes/a.md')).toBeUndefined()

    // The router (subscribed to the note moves) re-renders the pane with the
    // new path; the hook adopts the retargeted session — no reload, no new
    // epoch, so the live editor (and its cursor) survives.
    await hook.rerender({ path: 'notes/new-title.md' })
    await hook.act(async () => {})
    expect(hook.result.current.status).toBe('ready')
    expect(hook.result.current.sessionEpoch).toBe(epochBefore)

    // Subsequent edits land on the new path only — nothing resurrects a.md.
    await hook.act(() => hook.result.current.onEditorChange('# New Title\n\nmore\n'))
    await hook.act(() => clock.advance(1000))
    expect(file('notes/new-title.md')).toContain('# New Title\n\nmore\n')
    expect(file('notes/a.md')).toBeUndefined()
    await hook.unmount()
  })

  it('reloads a clean buffer on a real external change', async () => {
    const { result, act } = await readyHook()
    const editor = fakeEditor()
    await act(() => result.current.bindEditor(editor))

    noteFile.set('notes/a.md', '# Changed outside\n')
    await act(() => emitChange([{ path: 'notes/a.md', kind: 'upsert' }]))
    await vi.waitFor(() => expect(editor.applied).toEqual(['# Changed outside\n']))
    expect(result.current.dirty).toBe(false)
  })

  it('flushes the previous note when the path switches (final-flush snapshot)', async () => {
    noteFile.set('notes/b.md', '# Hello\n')

    const hook = await mount(
      ({ path }: { path: string } = { path: 'notes/a.md' }) => useNoteDocument(path),
      {
        initialProps: { path: 'notes/a.md' },
      },
    )
    await hook.act(() => clock.advance(0))

    // Dirty edit, then switch notes before the debounce fires: the unmount
    // flush must persist the OLD note's buffer to the OLD path.
    await hook.act(() => hook.result.current.onEditorChange('# Unsaved on A\n'))
    await hook.rerender({ path: 'notes/b.md' })
    await hook.act(() => clock.advance(2000))

    expect(noteFile.getWrites('notes/a.md')).toContain('# Unsaved on A\n')
    expect(noteFile.getWrites('notes/b.md')).toEqual([])
  })

  it('reconciles pending editor input during a same-path session rebind', async () => {
    const hook = await mount(
      ({ createIfMissing }: { createIfMissing: boolean } = { createIfMissing: false }) =>
        useNoteDocument('notes/a.md', { createIfMissing }),
      { initialProps: { createIfMissing: false } },
    )
    await hook.act(() => clock.advance(0))
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
    await hook.act(() => clock.advance(2000))

    expect(editor.getMarkdown).toHaveBeenCalled()
    expect(writes()).toContain('# Pending native input\n')
  })

  it('a same-graph generation bump keeps unsaved edits and saves with the new generation', async () => {
    const hook = await mount(() => useNoteDocument('notes/a.md'))
    await hook.act(() => clock.advance(0))

    // Reopening the same graph bumps the generation without remounting the
    // pane. The dirty buffer must survive (no dispose/reload-from-disk) and
    // the pending save must carry the NEW generation — a stale one would be
    // rejected by Rust and the edit silently lost.
    await hook.act(() => hook.result.current.onEditorChange('# Unsaved\n'))
    await hook.act(() => app.graphSession.setGraph({ generation: 2 }))
    expect(hook.result.current.dirty).toBe(true)

    await hook.act(() => clock.advance(1000))
    expect(noteFile.writes()).toEqual([
      { path: 'notes/a.md', contents: '# Unsaved\n', generation: 2 },
    ])
    expect(hook.result.current.dirty).toBe(false)
  })
})
