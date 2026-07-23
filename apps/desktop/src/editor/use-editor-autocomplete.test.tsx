import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useEditorAutocomplete } from './use-editor-autocomplete'

const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const ensurePersonNote = vi.hoisted(() => vi.fn())
const contactLinkSuggestions = vi.hoisted(() => vi.fn())
const resolvePersonContact = vi.hoisted(() => vi.fn())
const suggestWikiLinkTargets = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))
const settingsState = vi.hoisted(() => ({ contactsEnabled: false }))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets: async () => [],
  suggestWikiLinkTargets,
  suggestTags: async () => [],
  contactLinkSuggestions,
  ensurePersonNote,
  resolveOrCreateNoteWithTitle,
  resolvePersonContact,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { generation: 7 } }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      ...settingsState,
      dateFormat: 'MMM d, yyyy',
      weekStartDay: 1,
    },
  }),
}))
vi.mock('@/hooks/use-contacts-authorization', () => ({
  useContactsAuthorization: () => 'authorized',
}))
vi.mock('@/lib/operations', () => ({ startOperation }))

beforeEach(() => {
  resolveOrCreateNoteWithTitle.mockReset()
  ensurePersonNote.mockReset()
  contactLinkSuggestions.mockReset().mockResolvedValue([])
  resolvePersonContact.mockReset()
  settingsState.contactsEnabled = false
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

  it('uses an existing email owner as the Contact row target', async () => {
    settingsState.contactsEnabled = true
    const contact = {
      fullName: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      emails: ['ada@example.com'],
      phones: [],
    }
    contactLinkSuggestions.mockResolvedValue([contact])
    resolvePersonContact.mockResolvedValue({
      kind: 'existing',
      contact,
      emails: ['ada@example.com'],
      path: 'notes/augusta.md',
      title: 'Augusta Ada King',
      insertText: 'Augusta Ada King',
    })
    ensurePersonNote.mockResolvedValue({
      kind: 'existing',
      emails: ['ada@example.com'],
      path: 'notes/augusta.md',
      title: 'Augusta Ada King',
      insertText: 'Augusta Ada King',
    })
    const { result, act } = await renderHook(() => useEditorAutocomplete())

    const items = await result.current.onWikilinkSearch('Ada')
    expect(items).toMatchObject([
      {
        target: 'Augusta Ada King',
        label: 'Ada Lovelace',
        detail: 'ada@example.com',
      },
      { target: 'Ada', label: 'Create “Ada”' },
    ])

    await act(() => {
      items[0]!.onSelect?.()
    })
    await vi.waitFor(() =>
      expect(ensurePersonNote).toHaveBeenCalledWith({
        title: 'Ada Lovelace',
        emails: ['ada@example.com'],
        body: '- Type: #person\n- Email: ada@example.com',
        generation: 7,
      }),
    )
  })

  it('hides an exact blocked Contact and its Create fallback', async () => {
    settingsState.contactsEnabled = true
    const contact = {
      fullName: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      emails: ['ada@example.com'],
      phones: [],
    }
    contactLinkSuggestions.mockResolvedValue([contact])
    resolvePersonContact.mockResolvedValue({
      kind: 'blocked',
      contact,
      reason: 'identity-conflict',
    })
    const { result } = await renderHook(() => useEditorAutocomplete())

    await expect(
      result.current.onWikilinkSearch('Ada Lovelace'),
    ).resolves.toEqual([])
  })

  it('reports a failed Contact creation through the operation UI', async () => {
    settingsState.contactsEnabled = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const contact = {
      fullName: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      emails: ['ada@example.com'],
      phones: [],
    }
    contactLinkSuggestions.mockResolvedValue([contact])
    resolvePersonContact.mockResolvedValue({
      kind: 'new',
      contact,
      insertText: 'Ada Lovelace',
    })
    ensurePersonNote.mockRejectedValue(new Error('graph changed'))
    const { result, act } = await renderHook(() => useEditorAutocomplete())
    const items = await result.current.onWikilinkSearch('Ada Lovelace')

    await act(() => {
      items[0]!.onSelect?.()
    })

    await vi.waitFor(() => expect(operationFail).toHaveBeenCalledWith('graph changed'))
    consoleError.mockRestore()
  })
})
