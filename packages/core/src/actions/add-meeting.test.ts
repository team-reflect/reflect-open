import { beforeEach, describe, expect, it, vi } from 'vitest'
import { noteExists, readNote, writeNote } from '../graph/commands'
import { resolveWikiTarget } from '../indexing/queries'
import { resolved, unresolved } from '../markdown/resolve'
import { addMeetingToDaily, meetingLine, type AddMeetingInput } from './add-meeting'

vi.mock('../graph/commands', () => ({
  noteExists: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('../indexing/queries', () => ({
  resolveWikiTarget: vi.fn(),
}))

const noteExistsMock = vi.mocked(noteExists)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const resolveMock = vi.mocked(resolveWikiTarget)

const DAILY = 'daily/2026-07-01.md'
const GENERATION = 3

const notFound = () => ({ kind: 'notFound', message: 'missing' })

function input(overrides: Partial<AddMeetingInput> = {}): AddMeetingInput {
  return {
    date: '2026-07-01',
    title: 'Standup',
    attendees: [],
    createMeetingNote: false,
    generation: GENERATION,
    createNote: vi.fn(async (title: string) => `notes/${title.toLowerCase()}.md`),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  readNoteMock.mockRejectedValue(notFound())
  noteExistsMock.mockResolvedValue(false)
  resolveMock.mockImplementation(async (target) => unresolved(target))
})

describe('meetingLine', () => {
  it('links the meeting alone or with attendees', () => {
    expect(meetingLine('Standup', [])).toBe('- [[Standup]]')
    expect(meetingLine('Standup', ['Ada Lovelace', 'Grace Hopper'])).toBe(
      '- [[Standup]] with [[Ada Lovelace]], [[Grace Hopper]]',
    )
  })
})

describe('addMeetingToDaily', () => {
  it('appends the meeting under ## Meetings, creating the section on a fresh daily', async () => {
    const outcome = await addMeetingToDaily(input({ attendees: ['Ada Lovelace'] }))
    expect(outcome.appended).toBe(true)
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- [[Standup]] with [[Ada Lovelace]]\n',
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

  it('is idempotent: a day that already links the meeting is not rewritten', async () => {
    readNoteMock.mockResolvedValue('## Meetings\n\n- [[Standup]] with [[Ada Lovelace]]\n')
    const outcome = await addMeetingToDaily(input())
    expect(outcome.appended).toBe(false)
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('creates the meeting note only when asked and missing', async () => {
    const createNote = vi.fn(async () => 'notes/standup.md')
    await addMeetingToDaily(input({ createNote }))
    expect(createNote).not.toHaveBeenCalled()

    await addMeetingToDaily(input({ createMeetingNote: true, createNote }))
    expect(createNote).toHaveBeenCalledWith('Standup', GENERATION)

    createNote.mockClear()
    resolveMock.mockResolvedValue(resolved('notes/standup.md'))
    await addMeetingToDaily(input({ createMeetingNote: true, createNote }))
    expect(createNote).not.toHaveBeenCalled()
  })

  it('creates person notes for missing attendees, typed #person', async () => {
    const createNote = vi.fn(async () => 'notes/ada.md')
    resolveMock.mockImplementation(async (target) =>
      target === 'Grace Hopper' ? resolved('notes/grace-hopper.md') : unresolved(target),
    )
    const outcome = await addMeetingToDaily(
      input({ attendees: ['Ada Lovelace', 'Grace Hopper'], createNote }),
    )
    expect(createNote).toHaveBeenCalledTimes(1)
    expect(createNote).toHaveBeenCalledWith('Ada Lovelace', GENERATION, '- Type: #person')
    expect(outcome.createdNotes).toEqual(['Ada Lovelace'])
  })

  it('skips creation when the slug path already exists (index lag backstop)', async () => {
    const createNote = vi.fn(async () => 'notes/ada-lovelace.md')
    noteExistsMock.mockImplementation(async (path) => path === 'notes/ada-lovelace.md')
    await addMeetingToDaily(input({ attendees: ['Ada Lovelace'], createNote }))
    expect(createNote).not.toHaveBeenCalled()
  })

  it('sanitizes link-corrupting characters and deduplicates attendees', async () => {
    await addMeetingToDaily(
      input({
        title: '  Stand|up [v2]  ',
        attendees: ['Ada Lovelace', 'ada lovelace', '', 'Stand up v2'],
      }),
    )
    // `Stand up v2` also names the meeting itself, so it drops out of the
    // attendee links rather than duplicating the meeting link.
    expect(writeNoteMock).toHaveBeenCalledWith(
      DAILY,
      '## Meetings\n\n- [[Stand up v2]] with [[Ada Lovelace]]\n',
      GENERATION,
    )
  })

  it('does not create a person note for an attendee named like the meeting', async () => {
    const createNote = vi.fn(async () => 'notes/x.md')
    await addMeetingToDaily(input({ attendees: ['Standup'], createNote }))
    expect(createNote).not.toHaveBeenCalled()
  })

  it('rejects an empty meeting name', async () => {
    await expect(addMeetingToDaily(input({ title: '  [|]  ' }))).rejects.toThrow(
      'a meeting needs a name',
    )
    expect(writeNoteMock).not.toHaveBeenCalled()
  })
})
