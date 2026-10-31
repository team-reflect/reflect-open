import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNodeTestDatabaseService,
  createTestNoteCreationService,
  createTestNoteFileService,
  seedNotes,
  type TestDatabaseService,
  type TestNoteCreationService,
  type TestNoteFileService,
} from '../testing/index.ts'
import type { ContactMatch } from './commands.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createPersonNoteService, type PersonNoteService } from './person-note-service.ts'

let database: TestDatabaseService
let noteFile: TestNoteFileService
let noteCreation: TestNoteCreationService
let personNotes: PersonNoteService

/**
 * A `#person` note owning `emails`.
 */
function personNote(path: string, title: string, emails: readonly string[]) {
  return {
    path,
    markdown: [`# ${title}`, '', '- Type: #person', ...emails.map((email) => `- Email: ${email}`)]
      .join('\n')
      .concat('\n'),
  }
}

function contact(overrides: Partial<ContactMatch> = {}): ContactMatch {
  return {
    fullName: 'Ada Lovelace',
    givenName: 'Ada',
    familyName: 'Lovelace',
    emails: ['ada@example.com'],
    phones: [],
    ...overrides,
  }
}

beforeEach(() => {
  database = createNodeTestDatabaseService()
  noteFile = createTestNoteFileService()
  noteCreation = createTestNoteCreationService({ noteFile })
  personNotes = createPersonNoteService({
    database,
    wikiResolver: createWikiResolverService({ database }),
    noteCreation,
  })
})

describe('resolvePerson', () => {
  it('returns missing without querying for blank identities', async () => {
    await expect(personNotes.resolvePerson([' ', 'mailto: '])).resolves.toEqual({
      kind: 'missing',
      emails: [],
    })
    expect(database.getQueries()).toEqual([])
  })

  it('queries all canonical emails and reuses one owner', async () => {
    seedNotes(database, [personNote('notes/ada.md', 'Ada Lovelace', ['ada@example.com'])])

    await expect(
      personNotes.resolvePerson(['Ada <ADA@example.com>', 'ada@example.com', 'work@example.com']),
    ).resolves.toEqual({
      kind: 'existing',
      emails: ['ada@example.com', 'work@example.com'],
      path: 'notes/ada.md',
      title: 'Ada Lovelace',
      insertText: 'Ada Lovelace',
    })

    const query = database.getQueries()[0]!
    expect(query.sql).toContain('note_emails')
    expect(query.sql).toContain('tags')
    expect(query.sql).not.toContain('limit')
    expect(query.params).toEqual(['ada@example.com', 'work@example.com', 'person', 'note'])
  })

  it('deduplicates one owner found through several emails', async () => {
    seedNotes(database, [
      personNote('notes/ada.md', 'Ada Lovelace', ['ada@example.com', 'work@example.com']),
    ])

    await expect(
      personNotes.resolvePerson(['ada@example.com', 'work@example.com']),
    ).resolves.toMatchObject({
      kind: 'existing',
      path: 'notes/ada.md',
    })
  })

  it('blocks when the email union has several owners', async () => {
    seedNotes(database, [
      personNote('notes/ada.md', 'Ada', ['ada@example.com']),
      personNote('notes/augusta.md', 'Augusta', ['work@example.com']),
    ])

    await expect(
      personNotes.resolvePerson(['ada@example.com', 'work@example.com']),
    ).resolves.toEqual({
      kind: 'blocked',
      emails: ['ada@example.com', 'work@example.com'],
      reason: 'identity-conflict',
    })
    // The owner query alone: a conflict never asks for a wiki address.
    expect(database.getQueries()).toHaveLength(1)
  })

  it('blocks a unique owner without a safe wiki address', async () => {
    seedNotes(database, [personNote('notes/ada.md', 'Ada Lovelace', ['ada@example.com'])])
    const wikiResolver = createWikiResolverService({ database })
    vi.spyOn(wikiResolver, 'getWikiAddressForPath').mockResolvedValue(null)
    const unaddressable = createPersonNoteService({
      database,
      wikiResolver,
      noteCreation,
    })

    await expect(unaddressable.resolvePerson(['ada@example.com'])).resolves.toEqual({
      kind: 'blocked',
      emails: ['ada@example.com'],
      reason: 'unaddressable-owner',
    })
  })

  it('ignores an email owner that is not a person note', async () => {
    seedNotes(database, [
      { path: 'notes/ada.md', markdown: '# Ada Lovelace\n\n- Email: ada@example.com\n' },
    ])

    await expect(personNotes.resolvePerson(['ada@example.com'])).resolves.toEqual({
      kind: 'missing',
      emails: ['ada@example.com'],
    })
  })
})

describe('ensurePersonNote', () => {
  it('does not create when an owner already exists', async () => {
    seedNotes(database, [personNote('notes/ada.md', 'Ada Lovelace', ['ada@example.com'])])

    await expect(
      personNotes.ensurePersonNote({
        title: 'Ada',
        emails: ['ada@example.com'],
        generation: 7,
      }),
    ).resolves.toMatchObject({ kind: 'existing', path: 'notes/ada.md' })
    expect(noteCreation.created()).toEqual([])
  })

  it('does not create a conflicted identity', async () => {
    seedNotes(database, [
      personNote('notes/ada.md', 'Ada', ['ada@example.com']),
      personNote('notes/augusta.md', 'Augusta', ['ada@example.com']),
    ])

    await expect(
      personNotes.ensurePersonNote({
        title: 'Ada',
        emails: ['ada@example.com'],
        generation: 7,
      }),
    ).resolves.toMatchObject({ kind: 'blocked' })
    expect(noteCreation.created()).toEqual([])
  })

  it('creates a missing identity with its initial body', async () => {
    await expect(
      personNotes.ensurePersonNote({
        title: 'Ada',
        emails: ['ada@example.com'],
        body: '- Type: #person\n- Email: ada@example.com',
        generation: 7,
      }),
    ).resolves.toEqual({ kind: 'created', path: 'notes/ada.md' })
    expect(noteCreation.created()).toEqual(['notes/ada.md'])
    expect(noteFile.files().get('notes/ada.md')).toMatch(
      /# Ada\n\n- Type: #person\n- Email: ada@example\.com\n$/,
    )
  })
})

describe('resolvePersonContact', () => {
  it('uses an existing email owner target even when its title differs', async () => {
    seedNotes(database, [personNote('notes/augusta.md', 'Augusta Ada King', ['ada@example.com'])])
    const ada = contact()

    await expect(personNotes.resolvePersonContact(ada)).resolves.toEqual({
      kind: 'existing',
      contact: ada,
      emails: ['ada@example.com'],
      path: 'notes/augusta.md',
      title: 'Augusta Ada King',
      insertText: 'Augusta Ada King',
    })
  })

  it('returns a serializable new target for an unowned contact', async () => {
    const ada = contact()

    await expect(personNotes.resolvePersonContact(ada)).resolves.toEqual({
      kind: 'new',
      contact: ada,
      insertText: 'Ada Lovelace',
    })
  })

  it('blocks an unsafe new contact name', async () => {
    const ada = contact({ fullName: 'Ada | Augusta' })

    await expect(personNotes.resolvePersonContact(ada)).resolves.toEqual({
      kind: 'blocked',
      contact: ada,
      reason: 'unaddressable-contact',
    })
  })
})
