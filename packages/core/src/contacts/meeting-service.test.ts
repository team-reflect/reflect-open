import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersonNoteService, type PersonNoteService } from './person-note-service.ts'
import {
  createMeetingService,
  meetingLine,
  mergeAttendeeUpgrades,
  withAttendee,
  type AddMeetingInput,
  type MeetingService,
} from './meeting-service.ts'
import type { ContactMatch } from './commands.ts'
import { createSuggestionService } from '../indexing/suggestion-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import {
  createTestContactsService,
  createTestDatabaseService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestSettingsService,
  seedNotes,
  type NoteFileWrite,
  type TestContactsService,
  type TestDatabaseService,
  type TestNote,
  type TestNoteCreationService,
  type TestNoteFileService,
} from '../testing/index.ts'

const DAILY = 'daily/2026-07-01.md'
const GENERATION = 3

let database: TestDatabaseService
let noteFile: TestNoteFileService
let noteCreation: TestNoteCreationService
let contacts: TestContactsService
let personNotes: PersonNoteService
let meetings: MeetingService

function input(overrides: Partial<AddMeetingInput> = {}): AddMeetingInput {
  return {
    date: '2026-07-01',
    title: 'Standup',
    attendees: [],
    backlinkMeeting: true,
    ...overrides,
  }
}

/**
 * A `#person` note owning `emails`.
 */
function personNote(path: string, title: string, emails: readonly string[]): TestNote {
  return {
    path,
    markdown: [`# ${title}`, '', '- Type: #person', ...emails.map((email) => `- Email: ${email}`)]
      .join('\n')
      .concat('\n'),
  }
}

const JANE_CONTACT: ContactMatch = {
  fullName: 'Jane Doe',
  givenName: 'Jane',
  familyName: 'Doe',
  emails: ['jane@corp.com', 'jane@home.example'],
  phones: [],
}

/**
 * The emails of the most recent person-owner query.
 */
function lastResolvedEmails(): readonly unknown[] {
  const owners = database.getQueries().filter((query) => query.sql.includes('note_emails'))
  return owners.at(-1)?.params.slice(0, -2) ?? []
}

/**
 * The writes that landed on the daily note; note creation is a write to another path.
 */
function dailyWrites(): NoteFileWrite[] {
  return noteFile.writes().filter((write) => write.path === DAILY)
}

/**
 * The meeting service over this test's doubles, with `overrides` in place of the matching ones.
 */
function meetingService(
  overrides?: Partial<Parameters<typeof createMeetingService>[0]>,
): MeetingService {
  return createMeetingService({
    noteFile,
    noteCreation,
    wikiResolver: createWikiResolverService({ database }),
    suggestions: createSuggestionService({ database }),
    personNotes,
    contacts,
    settings: createTestSettingsService(),
    logger: createTestLoggerService(),
    graphSession: createTestGraphSessionService({ graph: { generation: GENERATION } }),
    ...overrides,
  })
}

beforeEach(() => {
  database = createTestDatabaseService()
  noteFile = createTestNoteFileService()
  noteCreation = createTestNoteCreationService({ noteFile })
  contacts = createTestContactsService()
  personNotes = createPersonNoteService({
    database,
    wikiResolver: createWikiResolverService({ database }),
    noteCreation,
  })
  meetings = meetingService()
})

describe('meetingLine', () => {
  // The bullet marker belongs to the list the entry lands in, so it is not
  // part of the rendered text here.
  it('renders linked and plain attendees', () => {
    expect(
      meetingLine({
        title: 'Standup',
        attendees: [
          { kind: 'linked', insertText: 'Ada Lovelace' },
          { kind: 'plain', text: 'Shared inbox' },
        ],
        backlinkMeeting: true,
        startTime: '9:00am',
      }),
    ).toBe('9:00am met with [[Ada Lovelace]], Shared inbox for [[Standup]]')
  })

  it('shortens attendee-less events and supports a plain meeting title', () => {
    expect(
      meetingLine({
        title: 'Standup',
        attendees: [],
        backlinkMeeting: true,
        startTime: '9:00am',
      }),
    ).toBe('9:00am [[Standup]]')
    expect(
      meetingLine({
        title: 'Standup',
        attendees: [{ kind: 'linked', insertText: 'Ada Lovelace' }],
        backlinkMeeting: false,
      }),
    ).toBe('Met with [[Ada Lovelace]] for Standup')
  })
})

describe('resolveAttendees', () => {
  it('renames an attendee to its unique email owner', async () => {
    seedNotes(database, [personNote('notes/jane.md', 'Jane Doe', ['jane@corp.com'])])

    await expect(
      meetings.resolveAttendees([{ name: 'jane@corp.com', emails: ['jane@corp.com'] }], false),
    ).resolves.toEqual([{ name: 'Jane Doe', emails: ['jane@corp.com'] }])
    expect(contacts.lookups()).toEqual([])
  })

  it('uses all Contact emails when a bare address resolves through Contacts', async () => {
    contacts.setContacts([JANE_CONTACT])

    await expect(
      meetings.resolveAttendees([{ name: 'Jane@Corp.com', emails: ['jane@corp.com'] }], true),
    ).resolves.toEqual([
      {
        name: 'Jane Doe',
        emails: ['jane@corp.com', 'jane@home.example'],
      },
    ])
    expect(lastResolvedEmails()).toEqual(['jane@corp.com', 'jane@home.example'])
  })

  it('keeps a calendar display name while collecting all Contact emails', async () => {
    contacts.setContacts([JANE_CONTACT])

    await expect(
      meetings.resolveAttendees([{ name: 'Doe, Jane', emails: ['jane@corp.com'] }], true),
    ).resolves.toEqual([
      {
        name: 'Doe, Jane',
        emails: ['jane@corp.com', 'jane@home.example'],
      },
    ])
    expect(lastResolvedEmails()).toEqual(['jane@corp.com', 'jane@home.example'])
  })

  it('keeps a conflicted Contact selectable under its original name', async () => {
    seedNotes(database, [
      personNote('notes/jane.md', 'Jane', ['jane@corp.com']),
      personNote('notes/janet.md', 'Janet', ['jane@home.example']),
    ])

    await expect(
      meetings.resolveAttendees(
        [
          {
            name: 'Jane Doe',
            emails: ['jane@corp.com', 'jane@home.example'],
          },
        ],
        true,
      ),
    ).resolves.toEqual([
      {
        name: 'Jane Doe',
        emails: ['jane@corp.com', 'jane@home.example'],
      },
    ])
    expect(contacts.lookups()).toEqual([])
  })

  it('blocks when a Contact lookup adds an email that conflicts between person notes', async () => {
    contacts.setContacts([JANE_CONTACT])
    seedNotes(database, [
      personNote('notes/jane.md', 'Jane', ['jane@home.example']),
      personNote('notes/janet.md', 'Janet', ['jane@home.example']),
    ])

    await expect(
      meetings.resolveAttendeeTargets([{ name: 'jane@corp.com', emails: ['jane@corp.com'] }], true),
    ).resolves.toEqual([
      {
        kind: 'plain',
        attendee: {
          name: 'Jane Doe',
          emails: ['jane@corp.com', 'jane@home.example'],
        },
      },
    ])
  })

  it('reuses the owner of an email that only the Contact lookup added', async () => {
    contacts.setContacts([JANE_CONTACT])
    seedNotes(database, [personNote('notes/jane.md', 'Jane D.', ['jane@home.example'])])

    await expect(
      meetings.resolveAttendeeTargets([{ name: 'jane@corp.com', emails: ['jane@corp.com'] }], true),
    ).resolves.toEqual([
      {
        kind: 'existing',
        attendee: { name: 'Jane D.', emails: ['jane@corp.com', 'jane@home.example'] },
        insertText: 'Jane D.',
      },
    ])
  })
})

describe('resolveAttendeeTargets', () => {
  it('links unique owners with their verified address', async () => {
    seedNotes(database, [personNote('notes/jane.md', 'Jane Doe', ['jane@corp.com'])])

    await expect(
      meetings.resolveAttendeeTargets(
        [{ name: 'jane@corp.com', emails: ['jane@corp.com'] }],
        false,
      ),
    ).resolves.toEqual([
      {
        kind: 'existing',
        attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
        insertText: 'Jane Doe',
      },
    ])
  })

  it('writes identity-conflict identities as plain text', async () => {
    seedNotes(database, [
      personNote('notes/jane.md', 'Jane', ['jane@corp.com']),
      personNote('notes/janet.md', 'Janet', ['jane@corp.com']),
    ])

    await expect(
      meetings.resolveAttendeeTargets([{ name: 'Jane Doe', emails: ['jane@corp.com'] }], false),
    ).resolves.toEqual([
      {
        kind: 'plain',
        attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
      },
    ])
  })

  it('writes unaddressable-owner identities as plain text', async () => {
    seedNotes(database, [personNote('notes/jane.md', 'Jane', ['jane@corp.com'])])
    const wikiResolver = Object.assign(createWikiResolverService({ database }), {
      getWikiAddressForPath: async () => null,
    })
    const unaddressable = meetingService({
      wikiResolver,
      personNotes: createPersonNoteService({ database, wikiResolver, noteCreation }),
    })

    await expect(
      unaddressable.resolveAttendeeTargets(
        [{ name: 'Jane Doe', emails: ['jane@corp.com'] }],
        false,
      ),
    ).resolves.toEqual([
      {
        kind: 'plain',
        attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
      },
    ])
  })

  it('returns a safe new target when no email owner exists', async () => {
    await expect(
      meetings.resolveAttendeeTargets([{ name: 'Jane Doe', emails: ['JANE@corp.com'] }], false),
    ).resolves.toEqual([
      {
        kind: 'new',
        attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
        insertText: 'Jane Doe',
      },
    ])
  })

  it('writes a new attendee with an unsafe name as plain text', async () => {
    await expect(
      meetings.resolveAttendeeTargets([{ name: '[|]', emails: ['jane@corp.com'] }], false),
    ).resolves.toEqual([
      {
        kind: 'plain',
        attendee: { name: '[|]', emails: ['jane@corp.com'] },
      },
    ])
  })
})

describe('addMeetingToDaily', () => {
  it('writes the daily line before creating missing notes', async () => {
    const outcome = await meetings.addMeetingToDaily(
      input({
        attendees: [
          {
            name: 'Ada Lovelace',
            emails: ['ada@example.com'],
          },
        ],
        backlinkMeeting: false,
        startTime: '9:00am',
      }),
    )

    expect(noteFile.writes().map((write) => write.path)).toEqual([DAILY, 'notes/ada-lovelace.md'])
    expect(dailyWrites()).toEqual([
      {
        path: DAILY,
        contents: '## Meetings\n\n- 9:00am met with [[Ada Lovelace]] for Standup\n',
        generation: GENERATION,
      },
    ])
    expect(noteFile.files().get('notes/ada-lovelace.md')).toMatch(
      /# Ada Lovelace\n\n- Type: #person\n- Email: ada@example\.com\n$/,
    )
    expect(noteFile.writes()[1]?.generation).toBe(GENERATION)
    expect(outcome).toEqual({
      appended: true,
      createdNotes: ['Ada Lovelace'],
    })
  })

  it('appends to an existing Meetings section of a non-empty daily', async () => {
    noteFile.set(DAILY, 'Some notes\n\n## Meetings\n\n- [[Kickoff]]\n\n## Later\n\nx\n')
    await meetings.addMeetingToDaily(input())
    const written = noteFile.getWrites(DAILY)[0]
    expect(written).toContain('## Meetings\n\n- [[Kickoff]]\n- [[Standup]]')
    expect(written).toContain('## Later')
  })

  it('extends only the leading Meetings list, before later daily-note prose', async () => {
    noteFile.set(DAILY, '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n\nScratchpad for later.\n')

    await meetings.addMeetingToDaily(input())

    expect(dailyWrites()).toEqual([
      {
        path: DAILY,
        contents:
          '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n- [[Standup]]\n\nScratchpad for later.\n',
        generation: GENERATION,
      },
    ])
  })

  it('recognizes the day’s meeting under a linked Meetings heading, where insertion files it', async () => {
    noteFile.set(DAILY, '## [[Meetings]]\n\n- 9:00am met with [[Ada Lovelace]] for [[Standup]]\n')

    await expect(
      meetings.addMeetingToDaily(input({ attendees: [{ name: 'Carol' }] })),
    ).resolves.toEqual({
      appended: false,
      createdNotes: [],
    })
    expect(noteFile.writes()).toEqual([])
  })

  it('is a full no-op when the meeting is already linked that day', async () => {
    noteFile.set(DAILY, '## Meetings\n\n- 9:00am met with [[Ada Lovelace]] for [[Standup]]\n')

    await expect(
      meetings.addMeetingToDaily(input({ attendees: [{ name: 'Carol', emails: ['carol@x.io'] }] })),
    ).resolves.toEqual({
      appended: false,
      createdNotes: [],
    })
    expect(noteFile.writes()).toEqual([])
    // No attendee was resolved and no note was created.
    expect(database.getQueries()).toEqual([])
    expect(noteCreation.created()).toEqual([])
  })

  it('does not treat a nested Meetings heading as the daily meeting section', async () => {
    noteFile.set(DAILY, '> ## Meetings\n> - [[Standup]]\n')

    const outcome = await meetings.addMeetingToDaily(input())

    expect(outcome.appended).toBe(true)
    expect(dailyWrites()).toEqual([
      {
        path: DAILY,
        contents: '> ## Meetings\n>\n> - [[Standup]]\n\n## Meetings\n\n- [[Standup]]\n',
        generation: GENERATION,
      },
    ])
  })

  it('recognizes an aliased meeting link in the Meetings section', async () => {
    noteFile.set(DAILY, '## Meetings\n\n- [[STANDUP|Daily sync]]\n')

    await expect(meetings.addMeetingToDaily(input())).resolves.toEqual({
      appended: false,
      createdNotes: [],
    })
  })

  it('matches a link whose alias (not target) carries the meeting name', async () => {
    noteFile.set(DAILY, '## Meetings\n\n- [[Standup|Daily sync]]\n')
    const outcome = await meetings.addMeetingToDaily(input({ title: 'Daily sync' }))
    expect(outcome.appended).toBe(false)
    expect(noteFile.writes()).toEqual([])
  })

  it('still appends when the title is only linked outside the Meetings section', async () => {
    noteFile.set(DAILY, 'Prep notes for [[Standup]] tomorrow.\n')
    const outcome = await meetings.addMeetingToDaily(input())
    expect(outcome.appended).toBe(true)
    const written = noteFile.getWrites(DAILY)[0]
    expect(written).toContain('## Meetings\n\n- [[Standup]]')
  })

  it('an un-backlinked meeting always appends, like v1 (plain text has no link to match)', async () => {
    noteFile.set(DAILY, '## Meetings\n\n- [[Standup]]\n')
    const outcome = await meetings.addMeetingToDaily(input({ backlinkMeeting: false }))
    expect(outcome.appended).toBe(true)
    const written = noteFile.getWrites(DAILY)[0]
    expect(written).toContain('- [[Standup]]\n- Standup')
  })

  it('creates a missing backlinked meeting note only', async () => {
    await expect(meetings.addMeetingToDaily(input({ backlinkMeeting: false }))).resolves.toEqual({
      appended: true,
      createdNotes: [],
    })
    expect(noteCreation.created()).toEqual([])

    await expect(meetings.addMeetingToDaily(input())).resolves.toEqual({
      appended: true,
      createdNotes: ['Standup'],
    })
    expect(noteCreation.created()).toEqual(['notes/standup.md'])
    expect(noteFile.files().get('notes/standup.md')).toMatch(/# Standup\n\n- Type: #meeting\n$/)
    expect(noteFile.writes().at(-1)?.generation).toBe(GENERATION)

    // Another day: the note written moments ago is found at its slug path
    // before the index has caught up with it.
    await expect(meetings.addMeetingToDaily(input({ date: '2026-07-02' }))).resolves.toEqual({
      appended: true,
      createdNotes: [],
    })
    expect(noteCreation.created()).toEqual(['notes/standup.md'])
  })

  it('does not create a meeting note for a title the index already resolves', async () => {
    seedNotes(database, [{ path: 'notes/daily-sync.md', markdown: '# Standup\n' }])

    await expect(meetings.addMeetingToDaily(input())).resolves.toEqual({
      appended: true,
      createdNotes: [],
    })
    expect(noteCreation.created()).toEqual([])
  })

  it('deduplicates attendee display names and removes the meeting itself', async () => {
    await meetings.addMeetingToDaily(
      input({
        attendees: [
          { name: 'Ada Lovelace' },
          { name: 'ada lovelace' },
          { name: '' },
          { name: 'Standup' },
        ],
        backlinkMeeting: false,
      }),
    )

    expect(dailyWrites()).toEqual([
      {
        path: DAILY,
        contents: '## Meetings\n\n- Met with [[Ada Lovelace]] for Standup\n',
        generation: GENERATION,
      },
    ])
    expect(noteCreation.created()).toEqual(['notes/ada-lovelace.md'])
  })

  it('rejects an empty meeting name before writing', async () => {
    await expect(meetings.addMeetingToDaily(input({ title: '  [|]  ' }))).rejects.toThrow(
      'a meeting needs a name',
    )
    expect(noteFile.writes()).toEqual([])
  })

  it('rejects with no graph open before writing', async () => {
    const closed = meetingService({ graphSession: createTestGraphSessionService({ graph: null }) })

    await expect(closed.addMeetingToDaily(input())).rejects.toThrow('No graph is open.')
    expect(noteFile.writes()).toEqual([])
  })
})

describe('attendee identity outcomes', () => {
  const JANE = { name: 'Jane Doe', emails: ['jane@corp.com'] }

  it('reuses an existing owner and does not create', async () => {
    seedNotes(database, [personNote('notes/jane.md', 'Jane Doe', ['jane@corp.com'])])

    const outcome = await meetings.addMeetingToDaily(
      input({
        attendees: [
          {
            name: 'jane@corp.com',
            emails: ['jane@corp.com'],
          },
        ],
        backlinkMeeting: false,
      }),
    )

    expect(noteFile.writes()).toEqual([
      {
        path: DAILY,
        contents: '## Meetings\n\n- Met with [[Jane Doe]] for Standup\n',
        generation: GENERATION,
      },
    ])
    expect(outcome.createdNotes).toEqual([])
  })

  it('writes an identity conflict as plain text without creating', async () => {
    seedNotes(database, [
      personNote('notes/jane.md', 'Jane', ['jane@corp.com']),
      personNote('notes/janet.md', 'Janet', ['jane@corp.com']),
    ])

    await meetings.addMeetingToDaily(input({ attendees: [JANE], backlinkMeeting: false }))

    expect(noteFile.writes()).toEqual([
      {
        path: DAILY,
        contents: '## Meetings\n\n- Met with Jane Doe for Standup\n',
        generation: GENERATION,
      },
    ])
  })

  it('writes an unaddressable owner as plain text without creating', async () => {
    seedNotes(database, [personNote('notes/jane.md', 'Jane', ['jane@corp.com'])])
    const wikiResolver = Object.assign(createWikiResolverService({ database }), {
      getWikiAddressForPath: async () => null,
    })
    const unaddressable = meetingService({
      wikiResolver,
      personNotes: createPersonNoteService({ database, wikiResolver, noteCreation }),
    })

    await unaddressable.addMeetingToDaily(input({ attendees: [JANE], backlinkMeeting: false }))

    expect(noteFile.writes()).toEqual([
      {
        path: DAILY,
        contents: '## Meetings\n\n- Met with Jane Doe for Standup\n',
        generation: GENERATION,
      },
    ])
  })

  it('fails before writing when identity resolution fails', async () => {
    const failing = meetingService({
      personNotes: {
        resolvePersonContact: (contact) => personNotes.resolvePersonContact(contact),
        ensurePersonNote: (input) => personNotes.ensurePersonNote(input),
        resolvePerson: async () => {
          throw new Error('index unavailable')
        },
      },
    })

    await expect(
      failing.addMeetingToDaily(
        input({
          attendees: [
            {
              name: 'Jane',
              emails: ['jane@corp.com'],
            },
          ],
        }),
      ),
    ).rejects.toThrow('index unavailable')
    expect(noteFile.writes()).toEqual([])
  })

  it('accepts a race that blocks creation after the daily write', async () => {
    const raced = meetingService({
      personNotes: {
        resolvePerson: (values) => personNotes.resolvePerson(values),
        resolvePersonContact: (contact) => personNotes.resolvePersonContact(contact),
        ensurePersonNote: () => ({
          kind: 'blocked',
          emails: ['ada@example.com'],
          reason: 'identity-conflict',
        }),
      },
    })

    const outcome = await raced.addMeetingToDaily(
      input({
        attendees: [
          {
            name: 'Ada Lovelace',
            emails: ['ada@example.com'],
          },
        ],
        backlinkMeeting: false,
      }),
    )

    expect(noteFile.writes()).toHaveLength(1)
    expect(outcome.createdNotes).toEqual([])
  })
})

describe('Contact prefill', () => {
  const ADA = {
    name: 'Ada Lovelace',
    emails: ['ada@example.com'],
  }

  beforeEach(() => {
    contacts.setContacts([
      {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        emails: ['ada@example.com', 'ada@work.example'],
        phones: ['+1 555-0100'],
      },
    ])
  })

  it('uses Contact details as the new note body', async () => {
    await meetings.addMeetingToDaily(input({ attendees: [ADA], lookupContacts: true }))

    expect(contacts.lookups()).toContainEqual({ kind: 'email', email: 'ada@example.com' })
    expect(noteFile.files().get('notes/ada-lovelace.md')).toMatch(
      /# Ada Lovelace\n\n- Type: #person\n- Email: ada@example\.com\n- Email: ada@work\.example\n- Phone: \+1 555-0100\n$/,
    )
  })

  it('falls back to the bare person body when Contacts has no owner of the email', async () => {
    contacts.setContacts([])

    await meetings.addMeetingToDaily(input({ attendees: [ADA], lookupContacts: true }))

    expect(noteFile.files().get('notes/ada-lovelace.md')).toMatch(
      /# Ada Lovelace\n\n- Type: #person\n- Email: ada@example\.com\n$/,
    )
  })

  it('persists attendee emails without touching Contacts when the gate is off', async () => {
    await meetings.addMeetingToDaily(input({ attendees: [ADA] }))

    expect(contacts.lookups()).toEqual([])
    expect(noteFile.files().get('notes/ada-lovelace.md')).toMatch(
      /# Ada Lovelace\n\n- Type: #person\n- Email: ada@example\.com\n$/,
    )
  })
})

describe('canLookupContacts', () => {
  it.each([
    { enabled: true, status: 'authorized', expected: true },
    { enabled: true, status: 'limited', expected: true },
    { enabled: true, status: 'denied', expected: false },
    { enabled: true, status: 'notDetermined', expected: false },
    { enabled: false, status: 'authorized', expected: false },
  ] as const)(
    'is $expected when contactsEnabled is $enabled and the permission is $status',
    async ({ enabled, status, expected }) => {
      const settings = createTestSettingsService({ contactsEnabled: enabled })
      await settings.whenLoaded()
      contacts.setStatus(status)

      expect(meetingService({ settings }).canLookupContacts()).toBe(expected)
    },
  )
})

describe('resolvePrefilledAttendees', () => {
  const PREFILLED = [{ name: 'jane@corp.com', emails: ['jane@corp.com'] }, { name: 'Bob' }]

  it('keys each prefilled attendee by its prefill name', async () => {
    seedNotes(database, [personNote('notes/jane.md', 'Jane Doe', ['jane@corp.com'])])

    const upgrades = await meetings.resolvePrefilledAttendees(PREFILLED)

    expect([...upgrades]).toEqual([
      ['jane@corp.com', { name: 'Jane Doe', emails: ['jane@corp.com'] }],
      ['Bob', { name: 'Bob' }],
    ])
    expect(contacts.lookups()).toEqual([])
  })

  it('looks attendees up in Contacts only behind the contacts gate', async () => {
    contacts.setContacts([
      {
        fullName: 'Jane Doe',
        givenName: 'Jane',
        familyName: 'Doe',
        emails: ['jane@corp.com', 'jane@home.example'],
        phones: [],
      },
    ])
    const settings = createTestSettingsService({ contactsEnabled: true })
    await settings.whenLoaded()

    const upgrades = await meetingService({ settings }).resolvePrefilledAttendees(PREFILLED)

    expect(upgrades.get('jane@corp.com')).toEqual({
      name: 'Jane Doe',
      emails: ['jane@corp.com', 'jane@home.example'],
    })
  })
})

describe('mergeAttendeeUpgrades', () => {
  it('upgrades chips by prefill name and keeps removals and additions', () => {
    const upgrades = new Map([
      ['jane@corp.com', { name: 'Jane Doe', emails: ['jane@corp.com'] }],
      ['Bob', { name: 'Bob' }],
    ])

    // Bob was removed and Carol added while resolution was in flight.
    expect(mergeAttendeeUpgrades([{ name: 'jane@corp.com' }, { name: 'Carol' }], upgrades)).toEqual(
      [{ name: 'Jane Doe', emails: ['jane@corp.com'] }, { name: 'Carol' }],
    )
  })

  it('drops a chip whose upgraded name repeats an earlier one, ignoring case', () => {
    const upgrades = new Map([['jane@corp.com', { name: 'Jane Doe' }]])

    expect(
      mergeAttendeeUpgrades([{ name: 'jane doe' }, { name: 'jane@corp.com' }], upgrades),
    ).toEqual([{ name: 'jane doe' }])
  })
})

describe('withAttendee', () => {
  it('appends a new name and keeps the list itself for a repeated one', () => {
    const current = [{ name: 'Ada' }]

    expect(withAttendee(current, { name: 'Bob' })).toEqual([{ name: 'Ada' }, { name: 'Bob' }])
    expect(withAttendee(current, { name: 'ADA' })).toBe(current)
  })
})

describe('attendeeSuggestions', () => {
  const GRACE = {
    fullName: 'Grace Hopper',
    givenName: 'Grace',
    familyName: 'Hopper',
    emails: ['grace@example.com'],
    phones: [],
  }

  beforeEach(() => {
    seedNotes(database, [
      { path: 'notes/grace-notes.md', markdown: '# Grace notes\n' },
      { path: 'daily/2026-07-01.md', markdown: 'Grace called.\n' },
    ])
    contacts.setContacts([GRACE, { ...GRACE, fullName: 'Grace Nobody', emails: [] }])
  })

  it('answers note titles and detailed contacts', async () => {
    const result = await meetings.attendeeSuggestions('gra', 6, true)

    expect(result.suggestions.map((suggestion) => suggestion.title)).toEqual(['Grace notes'])
    expect(result.contacts).toEqual([GRACE])
  })

  it('skips Contacts when the gate is off or the query is one letter', async () => {
    await expect(meetings.attendeeSuggestions('gra', 6, false)).resolves.toMatchObject({
      contacts: [],
    })
    await expect(meetings.attendeeSuggestions('g', 6, true)).resolves.toMatchObject({
      contacts: [],
    })
    expect(contacts.lookups()).toEqual([])
  })

  it('logs a Contacts failure and still answers the note suggestions', async () => {
    const logger = createTestLoggerService()
    const failure = new Error('contacts unavailable')
    const result = await meetingService({
      logger,
      contacts: {
        ...contacts,
        lookupPeople: async () => {
          throw failure
        },
      },
    }).attendeeSuggestions('gra', 6, true)

    expect(result.suggestions.map((suggestion) => suggestion.title)).toEqual(['Grace notes'])
    expect(result.contacts).toEqual([])
    expect(logger.getErrors()).toEqual([
      { message: 'contact link suggestions failed:', cause: failure },
    ])
  })

  it('drops daily notes from the suggestions', async () => {
    const suggestions = createSuggestionService({ database })
    vi.spyOn(suggestions, 'suggestWikiTargets').mockImplementation(async () => [
      {
        target: '2026-07-01',
        path: 'daily/2026-07-01.md',
        title: '2026-07-01',
        alias: null,
        date: '2026-07-01',
      },
      { target: 'Grace', path: 'notes/grace.md', title: 'Grace', alias: null, date: null },
    ])
    const result = await meetingService({ suggestions }).attendeeSuggestions('gra', 6, false)

    expect(result.suggestions.map((suggestion) => suggestion.title)).toEqual(['Grace'])
  })
})
