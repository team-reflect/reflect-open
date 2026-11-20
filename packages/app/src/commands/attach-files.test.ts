import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDatabaseService,
  createTestCoreServices,
  type TestCoreServices,
} from '@reflect/core/testing'
import type { AttachmentInsertTarget } from '@reflect/core'
import { createTestAppServices, type TestAppServices } from '../testing/services.ts'
import type { AppCommandId, CommandContext } from './app-command.ts'
import { attachFilesToNote } from './attach-files.ts'
import { noop } from '@ocavue/utils'

let core: TestCoreServices
let appLayer: TestAppServices<AppCommandId, CommandContext>
// The mounted note editors, by note path.
const editors = new Map<string, AttachmentInsertTarget>()

beforeEach(() => {
  core = createTestCoreServices({ database: createTestDatabaseService() })
  appLayer = createTestAppServices<AppCommandId, CommandContext>(core)
  core.graphSession.setGraph({ generation: 4 })
})

afterEach(() => {
  core.database.close()
  editors.clear()
})

function contextFor(notePath: string | null): CommandContext {
  return {
    services: core,
    app: appLayer,
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    noteEditor: (path) => editors.get(path) ?? null,
    notePath: () => notePath,
    back: vi.fn(),
    forward: vi.fn(),
    togglePin: vi.fn(noop),
    togglePrivate: vi.fn(noop),
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
    selectSection: vi.fn(),
    clearScrollState: vi.fn(),
  }
}

function editorHandle(): AttachmentInsertTarget {
  return { insertMarkdown: noop, focus: noop }
}

describe('attachFilesToNote', () => {
  it("attaches the picked files into the routed note's editor, looked up on every call", async () => {
    const handle = editorHandle()
    editors.set('notes/plan.md', handle)
    appLayer.dialog.setFiles(['/tmp/a.pdf'])

    await attachFilesToNote(contextFor('notes/plan.md'))

    expect(appLayer.dialog.calls()).toEqual([
      { kind: 'files', options: { multiple: true, title: 'Attach files' } },
    ])
    const [request] = core.attachments.attachRequests()
    expect(request?.sources).toEqual(['/tmp/a.pdf'])
    expect(request?.findEditor()).toBe(handle)
    editors.delete('notes/plan.md')
    expect(request?.findEditor()).toBeNull()
  })

  it('does nothing without a routed note, an editor, a graph session or a pick', async () => {
    appLayer.dialog.setFiles(['/tmp/a.pdf'])
    await attachFilesToNote(contextFor(null))
    await attachFilesToNote(contextFor('notes/plan.md'))
    const handle = editorHandle()
    editors.set('notes/plan.md', handle)
    core.graphSession.setGraph(null)
    await attachFilesToNote(contextFor('notes/plan.md'))
    core.graphSession.setGraph({ generation: 4 })
    appLayer.dialog.setFiles(null)
    await attachFilesToNote(contextFor('notes/plan.md'))
    editors.delete('notes/plan.md')

    expect(core.attachments.attachRequests()).toEqual([])
    expect(appLayer.dialog.calls()).toHaveLength(1)
  })
})
