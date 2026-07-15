import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry'
import type { NoteEditorHandle } from '@/editor/note-editor'
import type { CommandContext } from '@/lib/commands/types'
import { attachFilesToNote } from './attach-files'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }))

function contextFor(
  notePath: string | null,
  graphGeneration: number | null,
  indexGeneration = graphGeneration,
): CommandContext {
  return {
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => notePath,
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    graph: () =>
      graphGeneration === null
        ? null
        : { root: '/g', name: 'g', generation: graphGeneration },
    generation: () => indexGeneration,
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    clearScrollState: vi.fn(),
  }
}

function editorHandle(): NoteEditorHandle & {
  insertMarkdown: ReturnType<typeof vi.fn<(markdown: string) => void>>
} {
  return {
    getMarkdown: () => '',
    setMarkdown: () => {},
    insertMarkdown: vi.fn<(markdown: string) => void>(),
    focus: () => {},
    revealHeading: () => false,
    setSelection: () => {},
    getSelectedText: () => '',
    openSelectionMenu: () => {},
    startPendingReplacement: () => false,
    appendPendingReplacementText: () => {},
    acceptPendingReplacement: () => {},
    discardPendingReplacement: () => {},
  }
}

afterEach(() => {
  setBridge(null)
  openMock.mockReset()
})

describe('attachFilesToNote', () => {
  it('imports supported non-images and inserts source-relative file links', async () => {
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) =>
      typeof args['desiredName'] === 'string' ? `assets/${args['desiredName'] as string}` : null,
    )
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue(['/Users/me/Q3 Report.pdf', '/Users/me/interview.mp3'])
    const handle = editorHandle()
    registerNoteEditorHandle('Projects/2026/Plan.md', handle)

    await attachFilesToNote(contextFor('Projects/2026/Plan.md', 4))

    expect(invoke).toHaveBeenCalledWith('asset_import', {
      sourcePath: '/Users/me/Q3 Report.pdf',
      desiredName: 'q3-report.pdf',
      generation: 4,
    })
    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '[Q3 Report.pdf](../../assets/q3-report.pdf)\n' +
        '[interview.mp3](../../assets/interview.mp3)',
    )
    unregisterNoteEditorHandle('Projects/2026/Plan.md', handle)
  })

  it('inserts supported images with Markdown image syntax', async () => {
    const invoke = vi.fn(async () => 'assets/sunset.png')
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue('/Users/me/Sunset.png')
    const handle = editorHandle()
    registerNoteEditorHandle('Projects/Plan.md', handle)

    await attachFilesToNote(contextFor('Projects/Plan.md', 4))

    expect(invoke).toHaveBeenCalledWith('asset_import', {
      sourcePath: '/Users/me/Sunset.png',
      desiredName: 'sunset.png',
      generation: 4,
    })
    expect(handle.insertMarkdown).toHaveBeenCalledWith('![Sunset.png](../assets/sunset.png)')
    unregisterNoteEditorHandle('Projects/Plan.md', handle)
  })

  it('pins attachment copies to the graph generation, not the index session', async () => {
    const invoke = vi.fn(async () => 'assets/manual.pdf')
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue('/Users/me/manual.pdf')
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)

    await attachFilesToNote(contextFor('notes/plan.md', 4, 99))

    expect(invoke).toHaveBeenCalledWith('asset_import', {
      sourcePath: '/Users/me/manual.pdf',
      desiredName: 'manual.pdf',
      generation: 4,
    })
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('escapes bracketed filenames in the link label', async () => {
    const invoke = vi.fn(async () => 'assets/report-v2.pdf')
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue('/tmp/report [v2].pdf')
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      String.raw`[report \[v2\].pdf](../assets/report-v2.pdf)`,
    )
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('does nothing without a routed note, a mounted editor, or a pick', async () => {
    const invoke = vi.fn(async () => 'assets/x')
    setBridge({ invoke, listen: async () => () => {} })

    await attachFilesToNote(contextFor(null, 4))
    expect(openMock).not.toHaveBeenCalled()

    // Routed note but no mounted editor for it.
    await attachFilesToNote(contextFor('notes/closed.md', 4))
    expect(openMock).not.toHaveBeenCalled()

    // Cancelled picker.
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)
    openMock.mockResolvedValue(null)
    await attachFilesToNote(contextFor('notes/plan.md', 4))
    expect(invoke).not.toHaveBeenCalled()
    expect(handle.insertMarkdown).not.toHaveBeenCalled()
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('re-resolves the editor after the picker and drops the insert when it unmounted', async () => {
    const invoke = vi.fn(async () => 'assets/report.pdf')
    setBridge({ invoke, listen: async () => () => {} })
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)
    // The pane unmounts while the (native, unbounded) picker is open.
    openMock.mockImplementation(async () => {
      unregisterNoteEditorHandle('notes/plan.md', handle)
      return '/tmp/report.pdf'
    })

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    // The copy still happened (the file exists in assets/) but nothing is
    // dispatched into the dead editor.
    expect(invoke).toHaveBeenCalledWith('asset_import', expect.anything())
    expect(handle.insertMarkdown).not.toHaveBeenCalled()
  })

  it('rejects unsupported formats before copy and still links every supported file', async () => {
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) => {
      return `assets/${args['desiredName'] as string}`
    })
    setBridge({ invoke, listen: async () => () => {} })
    // The unsupported file comes FIRST: the supported files after it must
    // still import, while no native copy is attempted for the rejection.
    openMock.mockResolvedValue(['/tmp/bad.bin', '/tmp/good.pdf', '/tmp/also good.pdf'])
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle)

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalledWith(
      'asset_import',
      expect.objectContaining({ sourcePath: '/tmp/bad.bin' }),
    )
    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '[good.pdf](../assets/good.pdf)\n[also good.pdf](../assets/also-good.pdf)',
    )
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })
})
