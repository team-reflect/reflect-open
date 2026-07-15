import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DateSuggestionContext, WikiSuggestion } from '@reflect/core'
import { useEditorAutocomplete } from './use-editor-autocomplete'

const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const suggestWikiTargets = vi.hoisted(() =>
  vi.fn<
    (
      query: string,
      limit?: number,
      dateGeneration?: DateSuggestionContext,
      generation?: number,
    ) => Promise<WikiSuggestion[]>
  >(async () => []),
)
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets,
  suggestTags: async () => [],
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
  resolveOrCreateNoteWithTitle.mockReset()
  operationFail.mockReset()
  startOperation.mockClear()
  suggestWikiTargets.mockReset()
  suggestWikiTargets.mockResolvedValue([])
})

describe('useEditorAutocomplete', () => {
  it('shows parent paths only for path-qualified duplicate title rows', async () => {
    suggestWikiTargets.mockResolvedValue([
      {
        target: 'Clients/Acme/Plan',
        path: 'Clients/Acme/Plan.md',
        title: 'Plan',
        alias: null,
        date: null,
        disambiguated: true,
      },
      {
        target: 'Projects/Plan',
        path: 'Projects/Plan.md',
        title: 'Plan',
        alias: null,
        date: null,
        disambiguated: true,
      },
      {
        target: 'Roadmap',
        path: 'Roadmap.md',
        title: 'Roadmap',
        alias: null,
        date: null,
      },
    ])
    const { result } = renderHook(() => useEditorAutocomplete(7))

    const items = await result.current.onWikilinkSearch('plan')

    expect(suggestWikiTargets).toHaveBeenCalledWith(
      'plan',
      8,
      expect.objectContaining({ dateFormat: 'MMM d, yyyy' }),
      7,
    )
    expect(items.slice(0, 3)).toEqual([
      expect.objectContaining({ target: 'Clients/Acme/Plan', label: 'Plan', detail: 'Clients/Acme' }),
      expect.objectContaining({ target: 'Projects/Plan', label: 'Plan', detail: 'Projects' }),
      expect.objectContaining({ target: 'Roadmap', label: 'Roadmap' }),
    ])
    expect(items[2]).not.toHaveProperty('detail')
  })

  it('reports an ambiguous background create instead of silently doing nothing', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    })
    const { result } = renderHook(() => useEditorAutocomplete(7))
    const items = await result.current.onWikilinkSearch('Business ideas')

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() =>
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
    const { result } = renderHook(() => useEditorAutocomplete(7))
    const items = await result.current.onWikilinkSearch('Business ideas')

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Business ideas', 7),
    )
    expect(startOperation).toHaveBeenCalledWith('Creating note')
    expect(operationFail).toHaveBeenCalledWith(
      'Couldn’t create “Business ideas” while a potentially matching note is unavailable. Try again when it is available on this device.',
    )
  })

  it('reports an invalid background create instead of silently leaving the link unresolved', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({ kind: 'invalid' })
    const { result } = renderHook(() => useEditorAutocomplete(7))
    const items = await result.current.onWikilinkSearch('file://secret')

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('file://secret', 7),
    )
    expect(startOperation).toHaveBeenCalledWith('Creating note')
    expect(operationFail).toHaveBeenCalledWith(
      'Couldn’t create “file://secret” because it isn’t a valid note title or path.',
    )
  })

  it('surfaces a failed background create instead of silently doing nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    resolveOrCreateNoteWithTitle.mockRejectedValue(new Error('graph changed'))
    const { result } = renderHook(() => useEditorAutocomplete(7))
    const items = await result.current.onWikilinkSearch('Business ideas')

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() => expect(operationFail).toHaveBeenCalledWith('graph changed'))
    expect(startOperation).toHaveBeenCalledWith('Creating note')
    consoleError.mockRestore()
  })

  it('creates in the background without user-facing feedback on the happy path', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'created',
      path: 'notes/business-ideas.md',
    })
    const { result } = renderHook(() => useEditorAutocomplete(7))
    const items = await result.current.onWikilinkSearch('Business ideas')

    act(() => {
      items[0]!.onSelect?.()
    })

    await waitFor(() =>
      expect(resolveOrCreateNoteWithTitle).toHaveBeenCalledWith('Business ideas', 7),
    )
    expect(startOperation).not.toHaveBeenCalled()
    expect(operationFail).not.toHaveBeenCalled()
  })
})
