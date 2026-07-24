import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensurePersonNote } from '../contacts/person'
import { noteExists, readNote, writeNote } from '../graph/commands'
import { createNoteWithTitle } from '../graph/create-note'
import { resolveWikiTarget } from '../indexing/queries'
import { setBridge } from '../ipc/bridge'
import { resolved, unresolved } from '../markdown/resolve'
import {
  addMeetingToDaily,
  meetingLine,
  type AddMeetingInput,
  type MeetingAttendee,
} from './add-meeting'
import { resolveMeetingAttendeeTargets } from './resolve-attendees'

vi.mock('../contacts/person', () => ({
  ensurePersonNote: vi.fn(),
}))
vi.mock('../graph/commands', () => ({
  noteExists: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('../graph/create-note', () => ({
  createNoteWithTitle: vi.fn(),
}))
vi.mock('../indexing/queries', () => ({
  resolveWikiTarget: vi.fn(),
}))
vi.mock('./resolve-attendees', () => ({
  resolveMeetingAttendeeTargets: vi.fn(),
}))

const ensurePersonMock = vi.mocked(ensurePersonNote)
const noteExistsMock = vi.mocked(noteExists)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const createNoteMock = vi.mocked(createNoteWithTitle)
const resolveWikiTargetMock = vi.mocked(resolveWikiTarget)
const resolveAttendeesMock = vi.mocked(resolveMeetingAttendeeTargets)

const DAILY = 'daily/2026-07-01.md'
const GENERATION = 3

function input(overrides: Partial<AddMeetingInput> = {}): AddMeetingInput {
  return {
    date: '2026-07-01',
    title: 'Standup',
    attendees: [],
    backlinkMeeting: true,
    generation: GENERATION,
    ...overrides,
  }
}

function newTargets(attendees: readonly MeetingAttendee[]) {
  return attendees.map((attendee) => ({
    kind: 'new' as const,
    attendee,
    insertText: attendee.name,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  readNoteMock.mockRejectedValue({ kind: 'notFound', message: 'missing' })
  noteExistsMock.mockResolvedValue(false)
  createNoteMock.mockImplementation(async (title: string) => `notes/${title.toLowerCase()}.md`)
  resolveWikiTargetMock.mockImplementation(async (target) => unresolved(target))
  resolveAttendeesMock.mockImplementation(async (attendees) => newTargets(attendees))
  ensurePersonMock.mockImplementation(async ({ title }) => ({
    kind: 'created',
    path: `notes/${title.toLowerCase()}.md`,
  }))
})

describe('meetingLine', () => {
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
    ).toBe('- 9:00am met with [[Ada Lovelace]], Shared inbox for [[Standup]]')
  })

  it('shortens attendee-less events and supports a plain meeting title', () => {
    expect(
      meetingLine({
        title: 'Standup',
        attendees: [],
        backlinkMeeting: true,
        startTime: '9:00am',
      }),
    ).toBe('- 9:00am [[Standup]]')
    expect(
      meetingLine({
        title: 'Standup',
        attendees: [{ kind: 'linked', insertText: 'Ada Lovelace' }],
        backlinkMeeting: false,
      }),
    ).toBe('- Met with [[Ada Lovelace]] for Standup')
  })
})

describe('addMeetingToDaily', () => {
  it('writes the daily line before creating missing notes', async () => {
    const calls: string[] = []
    writeNoteMock.mockImplementation(async () => {
      calls.push('daily')
    })
    ensurePersonMock.mockImplementation(async () => {
      calls.push('person')
      return { kind: 'created', path: 'notes/ada.md' }
    })

    const outcome = await addMeetingToDaily(
      input({
        attendees: [{
          name: 'Ada Lovelace',
          emails: ['ada@example.com'],
        }],
        backlinkMeeting: false,
        startTime: '9:00am',
      }),
    )

    expect(calls).toEqual(['daily', 'person'])
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- 9:00am met with [[Ada Lovelace]] for Standup\n',
      GENERATION,
    )
    expect(ensurePersonMock).toHaveBeenCalledWith({
      title: 'Ada Lovelace',
      emails: ['ada@example.com'],
      body: '- Type: #person\n- Email: ada@example.com',
      generation: GENERATION,
    })
    expect(outcome).toEqual({
      appended: true,
      createdNotes: ['Ada Lovelace'],
    })
  })

  it('appends to an existing Meetings section of a non-empty daily', async () => {
    readNoteMock.mockResolvedValue('Some notes\n\n## Meetings\n\n- [[Kickoff]]\n\n## Later\n\nx\n')
    await addMeetingToDaily(input())
    const written = writeNoteMock.mock.calls[0]?.[1]
    expect(written).toContain('## Meetings\n\n- [[Kickoff]]\n- [[Standup]]')
    expect(written).toContain('## Later')
  })

  it('extends only the leading Meetings list, before later daily-note prose', async () => {
    readNoteMock.mockResolvedValue(
      '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n\nScratchpad for later.\n',
    )

    await addMeetingToDaily(input())

    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- [[Kickoff]]\n- [[Planning]]\n- [[Standup]]\n\nScratchpad for later.\n',
      GENERATION,
    )
  })

  it('is a full no-op when the meeting is already linked that day', async () => {
    readNoteMock.mockResolvedValue(
      '## Meetings\n\n- 9:00am met with [[Ada Lovelace]] for [[Standup]]\n',
    )

    await expect(
      addMeetingToDaily(input({ attendees: [{ name: 'Carol' }] })),
    ).resolves.toEqual({ appended: false, createdNotes: [] })
    expect(writeNoteMock).not.toHaveBeenCalled()
    expect(resolveAttendeesMock).not.toHaveBeenCalled()
    expect(ensurePersonMock).not.toHaveBeenCalled()
  })

  it('does not treat a nested Meetings heading as the daily meeting section', async () => {
    readNoteMock.mockResolvedValue('> ## Meetings\n> - [[Standup]]\n')

    const outcome = await addMeetingToDaily(input())

    expect(outcome.appended).toBe(true)
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '> ## Meetings\n> - [[Standup]]\n\n## Meetings\n\n- [[Standup]]\n',
      GENERATION,
    )
  })

  it('recognizes an aliased meeting link in the Meetings section', async () => {
    readNoteMock.mockResolvedValue('## Meetings\n\n- [[STANDUP|Daily sync]]\n')

    await expect(addMeetingToDaily(input())).resolves.toEqual({
      appended: false,
      createdNotes: [],
    })
  })

  it('matches a link whose alias (not target) carries the meeting name', async () => {
    readNoteMock.mockResolvedValue('## Meetings\n\n- [[Standup|Daily sync]]\n')
    const outcome = await addMeetingToDaily(input({ title: 'Daily sync' }))
    expect(outcome.appended).toBe(false)
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('still appends when the title is only linked outside the Meetings section', async () => {
    readNoteMock.mockResolvedValue('Prep notes for [[Standup]] tomorrow.\n')
    const outcome = await addMeetingToDaily(input())
    expect(outcome.appended).toBe(true)
    const written = writeNoteMock.mock.calls[0]?.[1]
    expect(written).toContain('## Meetings\n\n- [[Standup]]')
  })

  it('an un-backlinked meeting always appends, like v1 (plain text has no link to match)', async () => {
    readNoteMock.mockResolvedValue('## Meetings\n\n- [[Standup]]\n')
    const outcome = await addMeetingToDaily(input({ backlinkMeeting: false }))
    expect(outcome.appended).toBe(true)
    const written = writeNoteMock.mock.calls[0]?.[1]
    expect(written).toContain('- [[Standup]]\n- Standup')
  })

  it('creates a missing backlinked meeting note only', async () => {
    await addMeetingToDaily(input({ backlinkMeeting: false }))
    expect(createNoteMock).not.toHaveBeenCalled()

    await addMeetingToDaily(input())
    expect(createNoteMock).toHaveBeenCalledWith(
      'Standup',
      GENERATION,
      '- Type: #meeting',
    )

    createNoteMock.mockClear()
    resolveWikiTargetMock.mockResolvedValue(resolved('notes/standup.md'))
    await addMeetingToDaily(input())
    expect(createNoteMock).not.toHaveBeenCalled()
  })

  it('deduplicates attendee display names and removes the meeting itself', async () => {
    await addMeetingToDaily(
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

    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- Met with [[Ada Lovelace]] for Standup\n',
      GENERATION,
    )
    expect(ensurePersonMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty meeting name before writing', async () => {
    await expect(
      addMeetingToDaily(input({ title: '  [|]  ' })),
    ).rejects.toThrow('a meeting needs a name')
    expect(writeNoteMock).not.toHaveBeenCalled()
  })
})

describe('attendee identity outcomes', () => {
  it('reuses an existing owner and does not create', async () => {
    resolveAttendeesMock.mockResolvedValue([
      {
        kind: 'existing',
        attendee: {
          name: 'Jane Doe',
          emails: ['jane@corp.com'],
        },
        insertText: 'Jane Doe',
      },
    ])

    const outcome = await addMeetingToDaily(
      input({
        attendees: [{
          name: 'jane@corp.com',
          emails: ['jane@corp.com'],
        }],
        backlinkMeeting: false,
      }),
    )

    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- Met with [[Jane Doe]] for Standup\n',
      GENERATION,
    )
    expect(ensurePersonMock).not.toHaveBeenCalled()
    expect(outcome.createdNotes).toEqual([])
  })

  it.each(['identity conflict', 'unaddressable owner'])(
    'writes a %s as plain text without creating',
    async () => {
      resolveAttendeesMock.mockResolvedValue([
        {
          kind: 'plain',
          attendee: {
            name: 'Jane Doe',
            emails: ['jane@corp.com'],
          },
        },
      ])

      await addMeetingToDaily(
        input({
          attendees: [{
            name: 'Jane Doe',
            emails: ['jane@corp.com'],
          }],
          backlinkMeeting: false,
        }),
      )

      expect(writeNoteMock).toHaveBeenCalledWith(
        DAILY,
        '## Meetings\n\n- Met with Jane Doe for Standup\n',
        GENERATION,
      )
      expect(ensurePersonMock).not.toHaveBeenCalled()
    },
  )

  it('fails before writing when identity resolution fails', async () => {
    resolveAttendeesMock.mockRejectedValue(new Error('index unavailable'))

    await expect(
      addMeetingToDaily(
        input({
          attendees: [{
            name: 'Jane',
            emails: ['jane@corp.com'],
          }],
        }),
      ),
    ).rejects.toThrow('index unavailable')
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('accepts a race that blocks creation after the daily write', async () => {
    ensurePersonMock.mockResolvedValue({
      kind: 'blocked',
      emails: ['ada@example.com'],
      reason: 'identity-conflict',
    })

    const outcome = await addMeetingToDaily(
      input({
        attendees: [{
          name: 'Ada Lovelace',
          emails: ['ada@example.com'],
        }],
        backlinkMeeting: false,
      }),
    )

    expect(writeNoteMock).toHaveBeenCalled()
    expect(outcome.createdNotes).toEqual([])
  })
})

describe('Contact prefill', () => {
  const ADA = {
    name: 'Ada Lovelace',
    emails: ['ada@example.com'],
  }

  function installContactsBridge(contacts: unknown[]): ReturnType<typeof vi.fn> {
    const invoke = vi.fn(async () => contacts)
    setBridge({ invoke, listen: async () => () => {} })
    return invoke
  }

  afterEach(() => {
    setBridge(null)
  })

  it('uses Contact details as the new note body', async () => {
    const invoke = installContactsBridge([
      {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        emails: ['ada@example.com', 'ada@work.example'],
        phones: ['+1 555-0100'],
      },
    ])

    await addMeetingToDaily(
      input({ attendees: [ADA], lookupContacts: true }),
    )

    expect(invoke).toHaveBeenCalledWith(
      'contacts_lookup_by_email',
      { email: 'ada@example.com' },
    )
    expect(ensurePersonMock).toHaveBeenCalledWith({
      title: 'Ada Lovelace',
      emails: ['ada@example.com'],
      body:
        '- Type: #person\n- Email: ada@example.com\n- Phone: +1 555-0100',
      generation: GENERATION,
    })
  })

  it('persists attendee emails without touching Contacts when the gate is off', async () => {
    const invoke = installContactsBridge([])

    await addMeetingToDaily(input({ attendees: [ADA] }))

    expect(invoke).not.toHaveBeenCalled()
    expect(ensurePersonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        emails: ['ada@example.com'],
        body: '- Type: #person\n- Email: ada@example.com',
      }),
    )
  })
})
