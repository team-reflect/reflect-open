import { describe, expect, it, vi } from 'vitest'
import {
  createTestCoreServices,
  createTestGraphSessionService,
  createTestNoteFileService,
  createTestProgressPort,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import type { NoteEditorHandle } from './note-editor.tsx'
import { useTemplateSlashItems } from './use-template-slash-items.ts'

function setup() {
  const operations = createTestProgressPort()
  const base = createTestCoreServices({ database: createWasmTestDatabaseService() })
  const { templates } = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    graphSession: createTestGraphSessionService({ graph: {} }),
    noteFile: createTestNoteFileService({
      files: {
        'templates/journal.md': '# Journal\n\nMood:\n',
        'templates/person.md': '# Person\n\n- Company:\n',
      },
    }),
    indexQuery: {
      ...base.indexQuery,
      listTemplates: () => [
        { path: 'templates/journal.md', title: 'Journal', mtime: 1 },
        { path: 'templates/person.md', title: 'Person', mtime: 2 },
      ],
    },
    progress: operations,
  })
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    templates,
    progress: operations,
  })
  return { app, operations }
}

function fakeEditor(): NoteEditorHandle & { inserted: string[] } {
  const inserted: string[] = []
  return {
    inserted,
    getMarkdown: () => '',
    setMarkdown: () => {},
    insertMarkdown: (markdown) => {
      inserted.push(markdown)
    },
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

describe('useTemplateSlashItems', () => {
  it('maps templates to slash rows whose select inserts through the shared flow', async () => {
    const { app } = setup()
    const editor = fakeEditor()
    const { result } = await renderHookInApp(() => useTemplateSlashItems(() => editor), { app })

    const items = await result.current('jour')
    expect(
      items.map((item) => ({
        id: item.id,
        label: item.label,
        keywords: item.keywords,
      })),
    ).toEqual([
      // The shared "template" keyword is the v1 `/template` affordance.
      { id: 'templates/journal.md', label: 'Journal', keywords: ['template'] },
      { id: 'templates/person.md', label: 'Person', keywords: ['template'] },
    ])

    items[0]!.onSelect()
    await vi.waitFor(() => expect(editor.inserted).toEqual(['# Journal\n\nMood:\n']))
  })

  it('resolves the editor at select time, not capture time', async () => {
    // The pane unmounted between the menu opening and the select — the shared
    // flow receives null and surfaces the failure, never a stale editor.
    const { app, operations } = setup()
    const { result } = await renderHookInApp(() => useTemplateSlashItems(() => null), { app })
    const items = await result.current('')
    items[0]!.onSelect()
    await vi.waitFor(() =>
      expect(operations.snapshot()).toMatchObject([
        { label: 'Inserting template', status: 'failed', message: 'No open note to insert into' },
      ]),
    )
  })

  it('returns nothing without an open graph', async () => {
    const { app } = setup()
    const { result } = await renderHookInApp(() => useTemplateSlashItems(() => fakeEditor()), {
      app,
      graph: null,
    })
    await expect(result.current('')).resolves.toEqual([])
  })
})
