import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useEditorAutocomplete } from './use-editor-autocomplete'

const materializeDailyNote = vi.hoisted(() => vi.fn())
const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const suggestWikiLinkTargets = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets: async () => [],
  suggestWikiLinkTargets,
  suggestTags: async () => [],
  materializeDailyNote,
  resolveOrCreateNoteWithTitle,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { generation: 7 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      contactsEnabled: false,
      dateFormat: 'MMM d, yyyy',
      weekStartDay: 1,
    },
  }),
}))
vi.mock('@/hooks/use-contacts-authorization', () => ({
  useContactsAuthorization: () => null,
}))
vi.mock('@/lib/operations', () => ({ startOperation }))

beforeEach(() => {
  materializeDailyNote.mockReset().mockResolvedValue('daily/2026-07-27.md')
  resolveOrCreateNoteWithTitle.mockReset()
  suggestWikiLinkTargets.mockReset()
  suggestWikiLinkTargets.mockResolvedValue({
    suggestions: [],
    claimedTargetKeys: [],
    queryReadsAsDate: false,
  })
  operationFail.mockReset()
  startOperation.mockClear()
})

describe('useEditorAutocomplete', () => {
  it.each([
    { query: '2026-07-27', generated: undefined },
    { query: 'six days from now', generated: { phrase: 'Six days from now' } },
  ])('materializes a new daily when selecting $query', async ({ query, generated }) => {
    suggestWikiLinkTargets.mockResolvedValue({
      suggestions: [
        {
          target: '2026-07-27',
          insertText: '2026-07-27',
          title: '2026-07-27',
          alias: null,
          date: '2026-07-27',
          path: null,
          ...(generated === undefined ? {} : { generated }),
        },
      ],
      claimedTargetKeys: [],
      queryReadsAsDate: true,
    })
    const { result } = renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch(query)

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() =>
      expect(materializeDailyNote).toHaveBeenCalledWith('2026-07-27', 7),
    )
  })

  it('does not try to recreate an existing daily suggestion', async () => {
    suggestWikiLinkTargets.mockResolvedValue({
      suggestions: [
        {
          target: '2026-07-27',
          insertText: '2026-07-27',
          title: '2026-07-27',
          alias: null,
          date: '2026-07-27',
          path: 'daily/2026-07-27.md',
        },
      ],
      claimedTargetKeys: ['2026-07-27'],
      queryReadsAsDate: true,
    })
    const { result } = renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('2026-07-27')

    expect(items[0]?.onSelect).toBeUndefined()
    expect(materializeDailyNote).not.toHaveBeenCalled()
  })

  it('surfaces a failed daily creation instead of leaving a silent dangling link', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    materializeDailyNote.mockRejectedValue(new Error('graph changed'))
    suggestWikiLinkTargets.mockResolvedValue({
      suggestions: [
        {
          target: '2026-07-27',
          insertText: '2026-07-27',
          title: '2026-07-27',
          alias: null,
          date: '2026-07-27',
          path: null,
        },
      ],
      claimedTargetKeys: [],
      queryReadsAsDate: true,
    })
    const { result } = renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('2026-07-27')

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() => expect(operationFail).toHaveBeenCalledWith('graph changed'))
    expect(startOperation).toHaveBeenCalledWith('Creating daily note')
    consoleError.mockRestore()
  })

  it('does not offer create when the exact query has an unaddressable claim', async () => {
    suggestWikiLinkTargets.mockResolvedValue({
      suggestions: [],
      claimedTargetKeys: ['roadmap'],
      queryReadsAsDate: false,
    })
    const { result } = await renderHook(() => useEditorAutocomplete())

    await expect(result.current.onWikilinkSearch('Roadmap')).resolves.toEqual([])
  })

  it('reports an ambiguous background create instead of silently doing nothing', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    })
    const { result, act } = await renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('Business ideas')

    await act(() => {
      items[0]!.onSelect?.()
    })

    await vi.waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Business ideas', 7),
    )
    expect(startOperation).toHaveBeenCalledWith('Creating note')
    expect(operationFail).toHaveBeenCalledWith(
      'Couldn’t safely choose one note matching “Business ideas”. Rename conflicting notes or wait for unavailable notes to become available, then try again.',
    )
  })

  it('reports an unavailable background create distinctly from ambiguity', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    const { result, act } = await renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('Business ideas')

    await act(() => {
      items[0]!.onSelect?.()
    })

    await vi.waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Business ideas', 7),
    )
    expect(startOperation).toHaveBeenCalledWith('Creating note')
    expect(operationFail).toHaveBeenCalledWith(
      'Couldn’t create “Business ideas” while a potentially matching note is unavailable. Try again when it is available on this device.',
    )
  })

  it('surfaces a failed background create instead of silently doing nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    resolveOrCreateNoteWithTitle.mockRejectedValue(new Error('graph changed'))
    const { result, act } = await renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('Business ideas')

    await act(() => {
      items[0]!.onSelect?.()
    })

    await vi.waitFor(() => expect(operationFail).toHaveBeenCalledWith('graph changed'))
    expect(startOperation).toHaveBeenCalledWith('Creating note')
    consoleError.mockRestore()
  })

  it('creates in the background without user-facing feedback on the happy path', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'created',
      path: 'notes/business-ideas.md',
    })
    const { result, act } = await renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('Business ideas')

    await act(() => {
      items[0]!.onSelect?.()
    })

    await vi.waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Business ideas', 7),
    )
    expect(startOperation).not.toHaveBeenCalled()
    expect(operationFail).not.toHaveBeenCalled()
  })
})
