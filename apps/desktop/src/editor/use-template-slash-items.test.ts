import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NoteEditorHandle } from './note-editor'

const listTemplates = vi.hoisted(() =>
  vi.fn(async () => [
    { path: 'templates/journal.md', title: 'Journal', mtime: 1 },
    { path: 'templates/person.md', title: 'Person', mtime: 2 },
  ]),
)
const hasBridge = vi.hoisted(() => vi.fn(() => true))
const insertTemplate = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  listTemplates,
  hasBridge,
}))
vi.mock('@/lib/note-templates', () => ({ insertTemplate }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', generation: 1 } }),
}))

const { useTemplateSlashItems } = await import('./use-template-slash-items')

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
  }
}

describe('useTemplateSlashItems', () => {
  it('maps templates to slash rows whose select inserts through the shared flow', async () => {
    const editor = fakeEditor()
    const { result } = renderHook(() => useTemplateSlashItems(() => editor))

    const items = await result.current('jour')
    expect(
      items.map((item) => ({ id: item.id, label: item.label, keywords: item.keywords })),
    ).toEqual([
      // The shared "template" keyword is the v1 `/template` affordance.
      { id: 'templates/journal.md', label: 'Journal', keywords: ['template'] },
      { id: 'templates/person.md', label: 'Person', keywords: ['template'] },
    ])

    items[0]!.onSelect()
    await waitFor(() =>
      expect(insertTemplate).toHaveBeenCalledWith('templates/journal.md', editor),
    )
  })

  it('resolves the editor at select time, not capture time', async () => {
    // The pane unmounted between the menu opening and the select — the shared
    // flow receives null and surfaces the failure, never a stale editor.
    const { result } = renderHook(() => useTemplateSlashItems(() => null))
    const items = await result.current('')
    items[0]!.onSelect()
    await waitFor(() =>
      expect(insertTemplate).toHaveBeenCalledWith('templates/journal.md', null),
    )
  })

  it('returns nothing without a bridge', async () => {
    hasBridge.mockReturnValueOnce(false)
    const { result } = renderHook(() => useTemplateSlashItems(() => fakeEditor()))
    await expect(result.current('')).resolves.toEqual([])
  })
})
