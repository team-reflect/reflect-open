import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNodeTestDatabaseService,
  createTestCoreServices,
  type TestCoreServices,
} from '@reflect/core/testing'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import type { CommandContext } from '@/lib/commands/types.ts'
import { attachFilesToNote } from './attach-files.ts'

let core: TestCoreServices
let appLayer: TestAppServices

beforeEach(() => {
  core = createTestCoreServices({ database: createNodeTestDatabaseService() })
  appLayer = createTestAppServices(core)
  core.graphSession.setGraph({ generation: 4 })
})

afterEach(() => {
  core.database.close()
})

function contextFor(notePath: string | null): CommandContext {
  return {
    services: core,
    app: appLayer,
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => notePath,
    back: vi.fn(),
    forward: vi.fn(),
    togglePin: vi.fn(() => {}),
    togglePrivate: vi.fn(() => {}),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    clearScrollState: vi.fn(),
  }
}

function editorHandle(): NoteEditorHandle {
  return {
    getMarkdown: () => '',
    setMarkdown: () => {},
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

describe('attachFilesToNote', () => {
  it("attaches the picked files into the routed note's editor, looked up on every call", async () => {
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)
    appLayer.dialog.setFiles(['/tmp/a.pdf'])

    await attachFilesToNote(contextFor('notes/plan.md'))

    expect(appLayer.dialog.calls()).toEqual([
      { kind: 'files', options: { multiple: true, title: 'Attach files' } },
    ])
    const [request] = core.attachments.attachRequests()
    expect(request?.sources).toEqual(['/tmp/a.pdf'])
    expect(request?.findEditor()).toBe(handle)
    unregisterNoteEditorHandle('notes/plan.md', handle)
    expect(request?.findEditor()).toBeNull()
  })

  it('does nothing without a routed note, an editor, a graph session or a pick', async () => {
    appLayer.dialog.setFiles(['/tmp/a.pdf'])
    await attachFilesToNote(contextFor(null))
    await attachFilesToNote(contextFor('notes/plan.md'))
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)
    core.graphSession.setGraph(null)
    await attachFilesToNote(contextFor('notes/plan.md'))
    core.graphSession.setGraph({ generation: 4 })
    appLayer.dialog.setFiles(null)
    await attachFilesToNote(contextFor('notes/plan.md'))
    unregisterNoteEditorHandle('notes/plan.md', handle)

    expect(core.attachments.attachRequests()).toEqual([])
    expect(appLayer.dialog.calls()).toHaveLength(1)
  })
})
