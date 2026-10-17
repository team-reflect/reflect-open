import { beforeEach, describe, expect, it } from 'vitest'
import {
  createTestContactsService,
  createTestFileChangeService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestNoteFileService,
  createTestNoteSession,
  createTestSettingsService,
  type TestContactsService,
  type TestNoteFileService,
  type TestNoteSession,
} from '../testing/index.ts'
import { createNoteDocumentService } from '../documents/note-document-service.ts'
import {
  createOpenDocumentsService,
  type OpenDocumentsService,
} from '../documents/open-documents-service.ts'
import type { ContactMatch, ContactsAuthorization } from './commands.ts'
import {
  canPromptForContacts,
  createContactSuggestionService,
  contactsAccessNotice,
  isContactsAvailable,
  suggestedContactDetails,
  type ContactSuggestionService,
} from './contact-suggestion-service.ts'
import { contactsCanLookup, type ContactsService } from './contacts-service.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { SettingsService } from '../settings/settings-service.ts'

const PATH = 'notes/Ada Lovelace.md'

const ADA: ContactMatch = {
  fullName: 'Ada Lovelace',
  givenName: 'Ada',
  familyName: 'Lovelace',
  emails: ['ada@example.com'],
  phones: ['+1 555 0100'],
}

const ADA_BLOCK = '- Type: #person\n- Email: ada@example.com\n- Phone: +1 555 0100'

let contacts: TestContactsService
let noteFile: TestNoteFileService
let openDocuments: OpenDocumentsService
let service: ContactSuggestionService

/**

 * The real service; each dependency left out is a fresh test double.

 */
function contactSuggestionsOver(deps?: {
  contacts?: ContactsService
  openDocuments?: OpenDocumentsService
  noteFile?: NoteFileService
  settings?: SettingsService
  graphSession?: GraphSessionService
}): ContactSuggestionService {
  const openDocuments =
    deps?.openDocuments ??
    createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  const noteFile = deps?.noteFile ?? createTestNoteFileService()
  return createContactSuggestionService({
    contacts: deps?.contacts ?? createTestContactsService(),
    noteDocuments: createNoteDocumentService({
      openDocuments,
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
    }),
    openDocuments,
    noteFile,
    settings: deps?.settings ?? createTestSettingsService(),
    graphSession: deps?.graphSession ?? createTestGraphSessionService({ graph: { generation: 3 } }),
    logger: createTestLoggerService(),
  })
}

/**

 * Open the note in a pane: the session's buffer is then the note's live source.

 */
function openNote(content: string, options: { accepts?: boolean } = {}): TestNoteSession {
  const session = createTestNoteSession({ path: PATH, content, accepts: options.accepts ?? true })
  openDocuments.register({ session })
  return session
}

beforeEach(() => {
  contacts = createTestContactsService({ contacts: [ADA] })
  noteFile = createTestNoteFileService()
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  service = contactSuggestionsOver({ contacts, noteFile, openDocuments })
})

describe('suggestionFor', () => {
  it('answers the contact whose full name the title exactly matches', async () => {
    noteFile.set(PATH, '# Ada Lovelace\n')

    await expect(service.suggestionFor(PATH)).resolves.toEqual(ADA)
    expect(contacts.lookups()).toEqual([{ kind: 'name', name: 'Ada Lovelace' }])
  })

  it('reads the live buffer of an open note, not the file', async () => {
    noteFile.set(PATH, '# Grace Hopper\n')
    openNote('# Ada Lovelace\n')

    await expect(service.suggestionFor(PATH)).resolves.toEqual(ADA)
  })

  it('applies the exact-match rule to the looked-up candidates', async () => {
    contacts.setContacts([{ ...ADA, fullName: 'Ada Lovelace Byron' }, ADA])
    noteFile.set(PATH, '#  Ada Lovelace \n')

    await expect(service.suggestionFor(PATH)).resolves.toEqual(ADA)
  })

  it('answers null without a lookup when the body already carries contact details', async () => {
    noteFile.set(PATH, '# Ada Lovelace\n\n- Email: ada@example.com\n')

    await expect(service.suggestionFor(PATH)).resolves.toBeNull()
    expect(contacts.lookups()).toEqual([])
  })

  it('answers null without a lookup for an untitled note', async () => {
    const untitled = contactSuggestionsOver({
      contacts,
      openDocuments,
      noteFile: createTestNoteFileService({ files: { 'notes/.md': '\n' } }),
    })

    await expect(untitled.suggestionFor('notes/.md')).resolves.toBeNull()
    expect(contacts.lookups()).toEqual([])
  })

  it('answers null when no contact carries the title', async () => {
    noteFile.set(PATH, '# Grace Hopper\n')

    await expect(service.suggestionFor(PATH)).resolves.toBeNull()
  })

  it('answers null for a match with nothing to add', async () => {
    contacts.setContacts([{ ...ADA, emails: [], phones: [] }])
    noteFile.set(PATH, '# Ada Lovelace\n')

    await expect(service.suggestionFor(PATH)).resolves.toBeNull()
  })

  it('answers null for a contact dismissed on this note', async () => {
    noteFile.set(PATH, '---\nignoredContacts:\n  - ada lovelace\n---\n# Ada Lovelace\n')

    await expect(service.suggestionFor(PATH)).resolves.toBeNull()
    // The dismissal check needs the match's name, so the lookup does run.
    expect(contacts.lookups()).toEqual([{ kind: 'name', name: 'Ada Lovelace' }])
  })

  it('still suggests when another contact was dismissed', async () => {
    noteFile.set(PATH, '---\nignoredContacts:\n  - Grace Hopper\n---\n# Ada Lovelace\n')

    await expect(service.suggestionFor(PATH)).resolves.toEqual(ADA)
  })

  it('reads a note that has no file yet as empty', async () => {
    await expect(service.suggestionFor('notes/missing.md')).resolves.toBeNull()
  })
})

describe('addToNote', () => {
  it('appends the details block through the live session — a single write', async () => {
    const session = openNote('# Ada Lovelace\n')

    await service.addToNote(PATH, ADA)

    expect(session.getCalls('commitBodyAppend')).toEqual([[ADA_BLOCK]])
    // No frontmatter mark: the appended details suppress the card by content.
    expect(session.getCalls('commitFrontmatter')).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('refuses rather than clobber when the open session cannot take the append', async () => {
    openNote('# Ada Lovelace\n', { accepts: false })

    await expect(service.addToNote(PATH, ADA)).rejects.toThrow(/can’t be updated right now/)
    expect(noteFile.writes()).toEqual([])
  })

  it('patches a closed note on disk in one write', async () => {
    noteFile.set(PATH, '# Ada Lovelace\n')

    await service.addToNote(PATH, ADA)

    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents: `# Ada Lovelace\n\n${ADA_BLOCK}\n`,
        generation: 3,
      },
    ])
  })

  it('refuses when the title no longer matches the contact (stale card)', async () => {
    const session = openNote('# Grace Hopper\n')

    await expect(service.addToNote(PATH, ADA)).rejects.toThrow(/no longer matches/)
    expect(session.getCalls('commitBodyAppend')).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('appends only the details to an already-typed person note (meeting flow, link menu)', async () => {
    const session = openNote('# Ada Lovelace\n\n- Type: #person\n')

    await service.addToNote(PATH, ADA)

    expect(session.getCalls('commitBodyAppend')).toEqual([
      ['- Email: ada@example.com\n- Phone: +1 555 0100'],
    ])
  })

  it('is retry-idempotent: a body already carrying the block writes nothing', async () => {
    noteFile.set(PATH, `# Ada Lovelace\n\n${ADA_BLOCK}\n`)

    await service.addToNote(PATH, ADA)

    expect(noteFile.writes()).toEqual([])
  })

  it('skips when the body already has hand-typed details (stale card)', async () => {
    // The card would have been suppressed had its query refetched; Add must
    // apply the same content gate rather than stack a second block.
    const session = openNote('# Ada Lovelace\n\nWork mail ada@work.com\n')

    await service.addToNote(PATH, ADA)

    expect(session.getCalls('commitBodyAppend')).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('writes nothing for a contact with no details', async () => {
    const bare: ContactMatch = { ...ADA, emails: [], phones: [] }
    noteFile.set(PATH, '# Ada Lovelace\n')

    await service.addToNote(PATH, bare)

    expect(noteFile.writes()).toEqual([])
  })
})

describe('addToNote and ignore with no graph open', () => {
  it('throw without writing', async () => {
    noteFile = createTestNoteFileService()
    noteFile.set(PATH, '# Ada Lovelace\n')
    const closed = contactSuggestionsOver({
      noteFile,
      graphSession: createTestGraphSessionService({ graph: null }),
    })

    await expect(closed.addToNote(PATH, ADA)).rejects.toThrow('No graph is open.')
    await expect(closed.ignore(PATH, ADA)).rejects.toThrow('No graph is open.')
    expect(noteFile.writes()).toEqual([])
  })
})

describe('ignore', () => {
  it('records the contact name in ignoredContacts through the live session', async () => {
    const session = openNote('# Ada Lovelace\n')

    await service.ignore(PATH, ADA)

    expect(session.getCalls('commitFrontmatter')).toEqual([[{ ignoredContacts: ['Ada Lovelace'] }]])
    expect(session.getCalls('commitBodyAppend')).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('appends to an existing dismissal list on disk', async () => {
    noteFile.set(PATH, '---\nignoredContacts:\n  - Grace Hopper\n---\n# Ada Lovelace\n')

    await service.ignore(PATH, ADA)

    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents:
          '---\nignoredContacts:\n  - Grace Hopper\n  - Ada Lovelace\n---\n\n# Ada Lovelace\n',
        generation: 3,
      },
    ])
  })

  it('is idempotent: an already-dismissed contact writes nothing', async () => {
    noteFile.set(PATH, '---\nignoredContacts:\n  - ada lovelace\n---\n# Ada Lovelace\n')

    await service.ignore(PATH, ADA)

    expect(noteFile.writes()).toEqual([])
  })

  it('skips the write when the title no longer matches (stale card)', async () => {
    // The user wanted the stale card gone; the new title must stay eligible
    // for its own suggestion, so nothing is written.
    const session = openNote('# Grace Hopper\n')

    await service.ignore(PATH, ADA)

    expect(session.getCalls('commitFrontmatter')).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })
})

describe('the enable flow', () => {
  it('setEnabled persists the opt-in and never prompts', async () => {
    const settings = createTestSettingsService()
    await settings.whenLoaded()
    contacts.setStatus('notDetermined')
    const enabling = contactSuggestionsOver({ contacts, settings })

    enabling.setEnabled(true)
    expect(settings.get().contactsEnabled).toBe(true)
    enabling.setEnabled(false)
    expect(settings.get().contactsEnabled).toBe(false)

    expect(contacts.accessRequests()).toBe(0)
  })

  it('requestAccess prompts and the permission state then answers', async () => {
    contacts.setStatus('notDetermined')

    await service.requestAccess()

    expect(contacts.accessRequests()).toBe(1)
    expect(contacts.getState()).toEqual({ authorization: 'authorized' })
  })

  it('requestAccess swallows a failed prompt', async () => {
    const failing = contactSuggestionsOver({
      contacts: {
        getState: contacts.getState,
        subscribe: contacts.subscribe,
        refresh: () => contacts.refresh(),
        canLookup: (current) => contacts.canLookup(current),
        lookupPeople: (query) => contacts.lookupPeople(query),
        lookupByEmail: (email) => contacts.lookupByEmail(email),
        lookupByName: (name) => contacts.lookupByName(name),
        requestAccess: async () => {
          throw new Error('prompt timed out')
        },
      },
    })

    await expect(failing.requestAccess()).resolves.toBeUndefined()
  })

  it('only an undecided permission can still prompt', () => {
    expect(canPromptForContacts('notDetermined')).toBe(true)
    expect(canPromptForContacts('denied')).toBe(false)
    expect(canPromptForContacts('authorized')).toBe(false)
    expect(canPromptForContacts(null)).toBe(false)
  })
})

describe('showsSuggestionFor', () => {
  const ON = { contactsEnabled: true }

  function shows(
    settings: { contactsEnabled: boolean },
    authorization: ContactsAuthorization | null,
    path: string,
  ): boolean {
    const gated = contactSuggestionsOver({
      contacts: {
        getState: () => ({ authorization }),
        subscribe: contacts.subscribe,
        refresh: () => contacts.refresh(),
        requestAccess: () => contacts.requestAccess(),
        canLookup: (current) => contactsCanLookup({ authorization }, current),
        lookupPeople: (query) => contacts.lookupPeople(query),
        lookupByEmail: (email) => contacts.lookupByEmail(email),
        lookupByName: (name) => contacts.lookupByName(name),
      },
    })
    return gated.showsSuggestionFor(settings, path)
  }

  it('needs the integration on, a readable permission, and a non-daily note', () => {
    expect(shows(ON, 'authorized', PATH)).toBe(true)
    expect(shows(ON, 'limited', PATH)).toBe(true)
    expect(shows({ contactsEnabled: false }, 'authorized', PATH)).toBe(false)
    expect(shows(ON, 'denied', PATH)).toBe(false)
    expect(shows(ON, null, PATH)).toBe(false)
    expect(shows(ON, 'authorized', 'daily/2026-07-01.md')).toBe(false)
  })
})

describe('suggestedContactDetails', () => {
  it('joins the primary email and phone', () => {
    expect(
      suggestedContactDetails({ ...ADA, emails: ['ada@example.com', 'ada@work.example'] }),
    ).toBe('ada@example.com · +1 555 0100')
  })

  it('leaves out a missing or blank detail', () => {
    expect(suggestedContactDetails({ ...ADA, phones: [] })).toBe('ada@example.com')
    expect(suggestedContactDetails({ ...ADA, emails: [' '] })).toBe('+1 555 0100')
    expect(suggestedContactDetails({ ...ADA, emails: [], phones: [] })).toBe('')
  })
})

describe('isContactsAvailable', () => {
  it('is false while the first read is in flight and where the framework is missing', () => {
    expect(isContactsAvailable(null)).toBe(false)
    expect(isContactsAvailable('unavailable')).toBe(false)
    expect(isContactsAvailable('denied')).toBe(true)
    expect(isContactsAvailable('authorized')).toBe(true)
  })
})

describe('contactsAccessNotice', () => {
  const ON = { contactsEnabled: true }

  it('points a decided denial at System Settings', () => {
    expect(contactsAccessNotice(ON, 'denied', false)).toBe('denied')
    expect(contactsAccessNotice(ON, 'restricted', false)).toBe('denied')
  })

  it('offers the prompt again when enabled but never asked, unless a prompt is up', () => {
    expect(contactsAccessNotice(ON, 'notDetermined', false)).toBe('prompt')
    expect(contactsAccessNotice(ON, 'notDetermined', true)).toBeNull()
  })

  it('says nothing while the integration is off or access is granted', () => {
    expect(contactsAccessNotice({ contactsEnabled: false }, 'denied', false)).toBeNull()
    expect(contactsAccessNotice({ contactsEnabled: false }, 'notDetermined', false)).toBeNull()
    expect(contactsAccessNotice(ON, 'authorized', false)).toBeNull()
    expect(contactsAccessNotice(ON, null, false)).toBeNull()
  })
})
