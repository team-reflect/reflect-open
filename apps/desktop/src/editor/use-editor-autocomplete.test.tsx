import type {
  ContactMatch,
  ContactsAuthorization,
  ResolveOrCreateNoteResult,
  WikiLinkSuggestionResult,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestContactsService,
  createTestGraphSessionService,
  createTestSettingsService,
} from '@reflect/core/testing'
import { createTestOperationsService } from '@reflect/app/testing'
import { describe, expect, it, vi } from 'vitest'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useEditorAutocomplete } from './use-editor-autocomplete.ts'

const ADA: ContactMatch = {
  fullName: 'Ada Lovelace',
  givenName: 'Ada',
  familyName: 'Lovelace',
  emails: ['ada@example.com'],
  phones: [],
}

interface SetupOptions {
  contactsEnabled?: boolean
  authorization?: ContactsAuthorization
  wikiLinks?: WikiLinkSuggestionResult
  createOutcome?: ResolveOrCreateNoteResult
  /**
   * `null` renders the hook with no open graph.
   */
  graph?: null
}

/**
 * The hook over the real `AutocompleteSuggestionService` with scripted index and
 * address-book answers; the row rules themselves are covered in core.
 */
async function setup(options?: SetupOptions) {
  const operations = createTestOperationsService()
  const settings = createTestSettingsService(
    { contactsEnabled: options?.contactsEnabled ?? false },
    { progress: operations },
  )
  const created: { title: string; generation: number }[] = []
  const noteCreation = {
    resolveOrCreateNoteWithTitle: async (
      title: string,
      generation: number,
    ): Promise<ResolveOrCreateNoteResult> => {
      created.push({ title, generation })
      return options?.createOutcome ?? { kind: 'created', path: 'notes/created.md' }
    },
  }
  const contacts = createTestContactsService({
    status: options?.authorization ?? 'authorized',
    contacts: [ADA],
  })
  const base = createTestCoreServices()
  const personNotes: typeof base.personNotes = {
    ...base.personNotes,
    resolvePersonContact: (contact) => ({
      kind: 'new',
      contact,
      insertText: contact.fullName,
    }),
    ensurePersonNote: async (input) =>
      await noteCreation.resolveOrCreateNoteWithTitle(input.title, input.generation),
  }
  const graphSession = createTestGraphSessionService()
  const app = createTestCoreServices({
    graphSession,
    suggestions: {
      ...base.suggestions,
      suggestWikiLinkTargets: () =>
        options?.wikiLinks ?? { suggestions: [], claimedTargetKeys: [], queryReadsAsDate: false },
      suggestTags: () => [
        { tag: 'work', count: 2 },
        { tag: 'home', count: 1 },
      ],
    },
    noteCreation: Object.assign(base.noteCreation, noteCreation),
    contacts,
    personNotes,
    settings,
    progress: operations,
  })
  const { result } = await renderHookInApp(() => useEditorAutocomplete(), {
    app,
    graph: options?.graph === null ? null : { generation: 7 },
  })
  return { result, operations, created }
}

describe('useEditorAutocomplete', () => {
  it('returns the rows of the service and creates with the graph generation', async () => {
    const { result, operations, created } = await setup()
    const items = await result.current.onWikilinkSearch('Business ideas')
    expect(items).toMatchObject([{ target: 'Business ideas', label: 'Create “Business ideas”' }])

    items[0]!.onSelect?.()

    await vi.waitFor(() => expect(created).toEqual([{ title: 'Business ideas', generation: 7 }]))
    expect(operations.getAll()).toEqual([])
  })

  it('reports an ambiguous background create instead of silently doing nothing', async () => {
    const { result, operations } = await setup({
      createOutcome: {
        kind: 'ambiguous',
        paths: ['notes/business-ideas.md', 'notes/business-ideas-2.md'],
      },
    })
    const items = await result.current.onWikilinkSearch('Business ideas')

    items[0]!.onSelect?.()

    await vi.waitFor(() =>
      expect(operations.findByLabel('Creating note')).toMatchObject({
        status: 'failed',
        message:
          'Couldn’t safely choose one note matching “Business ideas”. Rename conflicting notes or wait for unavailable notes to become available, then try again.',
      }),
    )
  })

  it('does not offer create when the exact query has an unaddressable claim', async () => {
    const { result } = await setup({
      wikiLinks: { suggestions: [], claimedTargetKeys: ['roadmap'], queryReadsAsDate: false },
    })
    await expect(result.current.onWikilinkSearch('Roadmap')).resolves.toEqual([])
  })

  it('adds Contact rows once the integration is on and the permission readable', async () => {
    const { result } = await setup({ contactsEnabled: true })
    // The permission state arrives through a query; the row joins once it settles.
    await vi.waitFor(async () =>
      expect(await result.current.onWikilinkSearch('Ada Lovelace')).toMatchObject([
        { target: 'Ada Lovelace', label: 'Ada Lovelace', detail: 'ada@example.com' },
      ]),
    )
  })

  it('keeps Contact rows out while the integration is off', async () => {
    const { result } = await setup({ contactsEnabled: false })
    // Give the permission query time to settle: the setting alone must gate the rows.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(result.current.onWikilinkSearch('Ada Lovelace')).resolves.toMatchObject([
      { label: 'Create “Ada Lovelace”' },
    ])
  })

  it('searches tags through the service', async () => {
    const { result } = await setup()
    await expect(result.current.onTagSearch('o')).resolves.toEqual([
      { tag: 'work' },
      { tag: 'home' },
    ])
  })

  it('returns nothing without an open graph', async () => {
    const { result } = await setup({ graph: null })
    await expect(result.current.onWikilinkSearch('Business ideas')).resolves.toEqual([])
    await expect(result.current.onTagSearch('')).resolves.toEqual([])
  })
})
