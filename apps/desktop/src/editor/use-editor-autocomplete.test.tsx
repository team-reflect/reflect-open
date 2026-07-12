import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorAutocomplete } from './use-editor-autocomplete'

const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets: async () => [],
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
})

describe('useEditorAutocomplete', () => {
  it('reports an ambiguous background create instead of silently doing nothing', async () => {
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
    })
    const { result } = renderHook(() => useEditorAutocomplete())
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
    const { result } = renderHook(() => useEditorAutocomplete())
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

  it('surfaces a failed background create instead of silently doing nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    resolveOrCreateNoteWithTitle.mockRejectedValue(new Error('graph changed'))
    const { result } = renderHook(() => useEditorAutocomplete())
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
    const { result } = renderHook(() => useEditorAutocomplete())
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
