import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransformSelectionOptions, TransformStreamEvent } from '@reflect/core'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { useEditorAiMenu } from './use-editor-ai-menu'

const core = vi.hoisted(() => ({
  aiApiKeyForConfig: vi.fn<() => Promise<string | null>>(),
  transformSelection:
    vi.fn<(options: TransformSelectionOptions) => AsyncGenerator<TransformStreamEvent>>(),
}))
const note = vi.hoisted(() => ({ isPrivate: false }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  ...core,
}))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow: () => note }))
vi.mock('@/hooks/use-ai-providers', () => {
  const provider = { id: 'demo', provider: 'openai', model: 'gpt-5.4', keyHint: 'demo' }
  return { useAiProviders: () => ({ providers: [provider], defaultProvider: provider }) }
})
vi.mock('@/hooks/use-ai-prompts', () => ({
  useAiPrompts: () => ({
    prompts: [{ id: 'rewrite', label: 'Rewrite', body: '{{selectedText}}', mode: 'replace' }],
  }),
}))
vi.mock('@/routing/router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock('@/lib/provider-fetch', () => ({ providerFetch: vi.fn() }))

function createEditor(): NoteEditorHandle {
  return {
    getMarkdown: () => 'Original note',
    setMarkdown: vi.fn(),
    insertMarkdown: vi.fn(),
    focus: vi.fn(),
    setSelection: vi.fn(),
    getSelectedText: () => 'Original note',
    openSelectionMenu: vi.fn(),
    startPendingReplacement: vi.fn(() => true),
    appendPendingReplacementText: vi.fn(),
    acceptPendingReplacement: vi.fn(),
    discardPendingReplacement: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
  }
}

async function startRun(menu: ReturnType<typeof useEditorAiMenu>): Promise<void> {
  const context = { selectedText: 'Original note', from: 1, to: 14 }
  const items = await menu.onSelectionMenuSearch?.('Rewrite', context)
  expect(items?.[0]?.id).toBe('rewrite')
  act(() => items?.[0]?.onSelect(context))
}

beforeEach(() => {
  vi.clearAllMocks()
  note.isPrivate = false
  core.aiApiKeyForConfig.mockResolvedValue('demo-key')
})
afterEach(cleanup)

describe('editor AI while loading', () => {
  it('revokes a run made private before the key arrives', async () => {
    const key = Promise.withResolvers<string>()
    core.aiApiKeyForConfig.mockReturnValue(key.promise)
    const editor = createEditor()
    const editorRef = { current: editor }
    const hook = await renderHook(() =>
      useEditorAiMenu({ path: 'notes/test.md', sessionEpoch: 1, editorRef }),
    )
    await startRun(hook.result.current)
    note.isPrivate = true
    await hook.rerender()
    await act(async () => key.resolve('demo-key'))
    expect(core.transformSelection).not.toHaveBeenCalled()
    expect(editor.discardPendingReplacement).toHaveBeenCalledOnce()
    expect(hook.result.current.onSelectionMenuSearch).toBeUndefined()
  })

  it('aborts a loading transform on privacy change and ignores its late result', async () => {
    const loaded = Promise.withResolvers<void>()
    core.transformSelection.mockImplementation(async function* () {
      await loaded.promise
      yield { type: 'text-delta', text: 'Late result' }
    })
    const editor = createEditor()
    const editorRef = { current: editor }
    const hook = await renderHook(() =>
      useEditorAiMenu({ path: 'notes/test.md', sessionEpoch: 1, editorRef }),
    )
    await startRun(hook.result.current)
    await vi.waitFor(() => expect(core.transformSelection).toHaveBeenCalledOnce())
    const signal = core.transformSelection.mock.calls[0]?.[0].signal
    expect(signal?.aborted).toBe(false)
    note.isPrivate = true
    await hook.rerender()
    expect(signal?.aborted).toBe(true)
    await act(async () => loaded.resolve())
    expect(editor.discardPendingReplacement).toHaveBeenCalledOnce()
    expect(editor.appendPendingReplacementText).not.toHaveBeenCalled()
  })

  it('aborts a loading transform when its editor session is replaced', async () => {
    const loaded = Promise.withResolvers<void>()
    core.transformSelection.mockImplementation(async function* () {
      await loaded.promise
      yield { type: 'text-delta', text: 'Old session result' }
    })
    const editor = createEditor()
    const editorRef = { current: editor }
    const hook = await renderHook(
      (sessionEpoch = 1) => useEditorAiMenu({ path: 'notes/test.md', sessionEpoch, editorRef }),
      { initialProps: 1 },
    )
    await startRun(hook.result.current)
    await vi.waitFor(() => expect(core.transformSelection).toHaveBeenCalledOnce())
    const signal = core.transformSelection.mock.calls[0]?.[0].signal
    await hook.rerender(2)
    expect(signal?.aborted).toBe(true)
    await act(async () => loaded.resolve())
    expect(editor.appendPendingReplacementText).not.toHaveBeenCalled()
  })
})
