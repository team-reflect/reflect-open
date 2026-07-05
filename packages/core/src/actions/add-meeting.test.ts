import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteExists, readNote, writeNote } from '../graph/commands'
import { createNoteWithTitle } from '../graph/create-note'
import { noteTitleOwningEmail, resolveWikiTarget } from '../indexing/queries'
import { setBridge } from '../ipc/bridge'
import { resolved, unresolved } from '../markdown/resolve'
import { addMeetingToDaily, meetingLine, type AddMeetingInput } from './add-meeting'

vi.mock('../graph/commands', () => ({
  noteExists: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('../graph/create-note', () => ({
  createNoteWithTitle: vi.fn(),
}))
vi.mock('../indexing/queries', () => ({
  noteTitleOwningEmail: vi.fn(),
  resolveWikiTarget: vi.fn(),
}))

const noteExistsMock = vi.mocked(noteExists)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const createNoteMock = vi.mocked(createNoteWithTitle)
const resolveMock = vi.mocked(resolveWikiTarget)
const owningNoteMock = vi.mocked(noteTitleOwningEmail)

const DAILY = 'daily/2026-07-01.md'
const GENERATION = 3

const notFound = () => ({ kind: 'notFound', message: 'missing' })

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

beforeEach(() => {
  vi.clearAllMocks()
  readNoteMock.mockRejectedValue(notFound())
  noteExistsMock.mockResolvedValue(false)
  createNoteMock.mockImplementation(async (title: string) => `notes/${title.toLowerCase()}.md`)
  resolveMock.mockImplementation(async (target) => unresolved(target))
  owningNoteMock.mockResolvedValue(null)
})

describe('meetingLine', () => {
  it('renders the v1 shape: time, met with, for', () => {
    expect(
      meetingLine({
        title: 'Standup',
        attendees: ['Ada Lovelace', 'Grace Hopper'],
        backlinkMeeting: true,
        startTime: '9:00am',
      }),
    ).toBe('- 9:00am met with [[Ada Lovelace]], [[Grace Hopper]] for [[Standup]]')
  })

  it('shortens for attendee-less events and capitalizes without a time', () => {
    expect(
      meetingLine({ title: 'Standup', attendees: [], backlinkMeeting: true, startTime: '9:00am' }),
    ).toBe('- 9:00am [[Standup]]')
    expect(
      meetingLine({ title: 'Standup', attendees: ['Ada Lovelace'], backlinkMeeting: true }),
    ).toBe('- Met with [[Ada Lovelace]] for [[Standup]]')
  })

  it('writes the meeting name as plain text when not backlinked', () => {
    expect(
      meetingLine({
        title: 'Standup',
        attendees: ['Ada Lovelace'],
        backlinkMeeting: false,
        startTime: '9:00am',
      }),
    ).toBe('- 9:00am met with [[Ada Lovelace]] for Standup')
  })
})

describe('addMeetingToDaily', () => {
  it('appends the meeting under ## Meetings, creating the section on a fresh daily', async () => {
    const outcome = await addMeetingToDaily(
      input({ attendees: [{ name: 'Ada Lovelace' }], startTime: '9:00am' }),
    )
    expect(outcome.appended).toBe(true)
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- 9:00am met with [[Ada Lovelace]] for [[Standup]]\n',
      GENERATION,
    )
  })

  it('appends to an existing Meetings section of a non-empty daily', async () => {
    readNoteMock.mockResolvedValue('Some notes\n\n## Meetings\n\n- [[Kickoff]]\n\n## Later\n\nx\n')
    await addMeetingToDaily(input())
    const written = writeNoteMock.mock.calls[0]?.[1]
    expect(written).toContain('## Meetings\n\n- [[Kickoff]]\n\n- [[Standup]]')
    expect(written).toContain('## Later')
  })

  it('is idempotent: a day that already links the meeting is a full no-op', async () => {
    readNoteMock.mockResolvedValue('## Meetings\n\n- 9:00am met with [[Ada Lovelace]] for [[Standup]]\n')
    const outcome = await addMeetingToDaily(input({ attendees: [{ name: 'Carol' }] }))
    expect(outcome).toEqual({ appended: false, createdNotes: [] })
    expect(writeNoteMock).not.toHaveBeenCalled()
    // No invisible side effects either — a re-add must not mint notes the
    // daily line never gained.
    expect(createNoteMock).not.toHaveBeenCalled()
  })

  it('treats case-different and aliased Meetings links as already linked', async () => {
    readNoteMock.mockResolvedValue('## Meetings\n\n- [[STANDUP|Daily sync]]\n')
    const outcome = await addMeetingToDaily(input())
    expect(outcome.appended).toBe(false)
    expect(writeNoteMock).not.toHaveBeenCalled()
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
    expect(written).toContain('- [[Standup]]\n\n- Standup')
  })

  it('creates the meeting note (typed #meeting) only when backlinked and missing', async () => {
    await addMeetingToDaily(input({ backlinkMeeting: false }))
    expect(createNoteMock).not.toHaveBeenCalled()

    await addMeetingToDaily(input())
    expect(createNoteMock).toHaveBeenCalledWith('Standup', GENERATION, '- Type: #meeting')

    createNoteMock.mockClear()
    resolveMock.mockResolvedValue(resolved('notes/standup.md'))
    await addMeetingToDaily(input())
    expect(createNoteMock).not.toHaveBeenCalled()
  })

  it('creates person notes for missing attendees, typed #person', async () => {
    resolveMock.mockImplementation(async (target) =>
      target === 'Grace Hopper' || target === 'Standup'
        ? resolved(`notes/${target.toLowerCase()}.md`)
        : unresolved(target),
    )
    const outcome = await addMeetingToDaily(
      input({ attendees: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }] }),
    )
    expect(createNoteMock).toHaveBeenCalledTimes(1)
    expect(createNoteMock).toHaveBeenCalledWith('Ada Lovelace', GENERATION, '- Type: #person')
    expect(outcome.createdNotes).toEqual(['Ada Lovelace'])
  })

  it('skips creation when the slug path already exists (index lag backstop)', async () => {
    noteExistsMock.mockImplementation(async (path) => path === 'notes/ada-lovelace.md')
    await addMeetingToDaily(input({ attendees: [{ name: 'Ada Lovelace' }], backlinkMeeting: false }))
    expect(createNoteMock).not.toHaveBeenCalled()
  })

  it('sanitizes link-corrupting characters and deduplicates attendees', async () => {
    await addMeetingToDaily(
      input({
        title: '  Stand|up [v2]  ',
        attendees: [
          { name: 'Ada Lovelace' },
          { name: 'ada lovelace' },
          { name: '' },
          { name: 'Stand up v2' },
        ],
      }),
    )
    // `Stand up v2` also names the meeting itself, so it drops out of the
    // attendee links rather than duplicating the meeting link.
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- Met with [[Ada Lovelace]] for [[Stand up v2]]\n',
      GENERATION,
    )
  })

  it('does not create a person note for an attendee named like the meeting', async () => {
    resolveMock.mockImplementation(async (target) =>
      target === 'Standup' ? resolved('notes/standup.md') : unresolved(target),
    )
    await addMeetingToDaily(input({ attendees: [{ name: 'Standup' }] }))
    expect(createNoteMock).not.toHaveBeenCalled()
  })

  it('rejects an empty meeting name', async () => {
    await expect(addMeetingToDaily(input({ title: '  [|]  ' }))).rejects.toThrow(
      'a meeting needs a name',
    )
    expect(writeNoteMock).not.toHaveBeenCalled()
  })
})

describe('addMeetingToDaily attendee resolution', () => {
  it('links the note owning the invite email instead of minting a duplicate', async () => {
    owningNoteMock.mockImplementation(async (email) =>
      email === 'jane@corp.com' ? 'Jane Doe' : null,
    )
    resolveMock.mockImplementation(async (target) =>
      target === 'Jane Doe' ? resolved('notes/jane-doe.md') : unresolved(target),
    )
    const outcome = await addMeetingToDaily(
      input({
        attendees: [{ name: 'jane@corp.com', email: 'jane@corp.com' }],
        backlinkMeeting: false,
      }),
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- Met with [[Jane Doe]] for Standup\n',
      GENERATION,
    )
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(outcome.createdNotes).toEqual([])
  })

  it('collapses two spellings of one person once their emails resolve to the same note', async () => {
    owningNoteMock.mockResolvedValue('Jane Doe')
    resolveMock.mockImplementation(async (target) =>
      target === 'Jane Doe' ? resolved('notes/jane-doe.md') : unresolved(target),
    )
    await addMeetingToDaily(
      input({
        attendees: [
          { name: 'jane@corp.com', email: 'jane@corp.com' },
          { name: 'Doe, Jane', email: 'jane.doe@home.example' },
        ],
        backlinkMeeting: false,
      }),
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- Met with [[Jane Doe]] for Standup\n',
      GENERATION,
    )
  })

  it('resolution errors fail the call loudly rather than writing a duplicate-prone line', async () => {
    owningNoteMock.mockRejectedValue(new Error('index unavailable'))
    await expect(
      addMeetingToDaily(input({ attendees: [{ name: 'Jane', email: 'jane@corp.com' }] })),
    ).rejects.toThrow('index unavailable')
    expect(createNoteMock).not.toHaveBeenCalled()
  })
})

describe('addMeetingToDaily contact pre-fill', () => {
  const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' }

  function installContactsBridge(contacts: unknown[]): ReturnType<typeof vi.fn> {
    const invoke = vi.fn(async () => contacts)
    setBridge({ invoke, listen: async () => () => {} })
    return invoke
  }

  afterEach(() => {
    setBridge(null)
  })

  it('pre-fills a created person note from the matching contact', async () => {
    const invoke = installContactsBridge([
      {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        emails: ['ada@example.com'],
        phones: ['+1 555-0100'],
      },
    ])
    await addMeetingToDaily(input({ attendees: [ADA], lookupContacts: true }))
    expect(invoke).toHaveBeenCalledWith('contacts_lookup_by_email', { email: 'ada@example.com' })
    expect(createNoteMock).toHaveBeenCalledWith(
      'Ada Lovelace',
      GENERATION,
      '- Type: #person\n- Email: ada@example.com\n- Phone: +1 555-0100',
    )
  })

  it('names and pre-fills the created note from the contact when the calendar only knew the address', async () => {
    installContactsBridge([
      {
        fullName: 'Ada Lovelace',
        givenName: 'Ada',
        familyName: 'Lovelace',
        emails: ['ada@example.com'],
        phones: [],
      },
    ])
    const outcome = await addMeetingToDaily(
      input({
        attendees: [{ name: 'ada@example.com', email: 'ada@example.com' }],
        lookupContacts: true,
      }),
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      expect.stringContaining('[[Ada Lovelace]]'),
      GENERATION,
    )
    expect(createNoteMock).toHaveBeenCalledWith(
      'Ada Lovelace',
      GENERATION,
      '- Type: #person\n- Email: ada@example.com',
    )
    expect(outcome.createdNotes).toContain('Ada Lovelace')
  })

  it('creates the bare typed note on a lookup miss, as v1 did', async () => {
    installContactsBridge([])
    await addMeetingToDaily(input({ attendees: [ADA], lookupContacts: true }))
    expect(createNoteMock).toHaveBeenCalledWith('Ada Lovelace', GENERATION, '- Type: #person')
  })

  it('never touches the bridge while the contacts gate is off', async () => {
    const invoke = installContactsBridge([])
    await addMeetingToDaily(input({ attendees: [ADA] }))
    expect(invoke).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith('Ada Lovelace', GENERATION, '- Type: #person')
  })

  it('skips the lookup for attendees without an invite email', async () => {
    const invoke = installContactsBridge([])
    await addMeetingToDaily(
      input({ attendees: [{ name: 'Grace Hopper' }], lookupContacts: true }),
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith('Grace Hopper', GENERATION, '- Type: #person')
  })

  it('does not look up attendees whose note already exists', async () => {
    const invoke = installContactsBridge([])
    resolveMock.mockImplementation(async (target) =>
      target === 'Ada Lovelace' ? resolved('notes/ada-lovelace.md') : unresolved(target),
    )
    await addMeetingToDaily(input({ attendees: [ADA], lookupContacts: true }))
    expect(invoke).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledTimes(1)
    expect(createNoteMock).toHaveBeenCalledWith('Standup', GENERATION, '- Type: #meeting')
  })
})
