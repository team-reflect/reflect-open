import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAttendeeContact } from '../contacts/resolve'
import { noteTitleOwningEmail } from '../indexing/queries'
import { resolveMeetingAttendees } from './resolve-attendees'

vi.mock('../indexing/queries', () => ({
  noteTitleOwningEmail: vi.fn(),
}))
vi.mock('../contacts/resolve', () => ({
  resolveAttendeeContact: vi.fn(),
}))

const owningNoteMock = vi.mocked(noteTitleOwningEmail)
const contactMock = vi.mocked(resolveAttendeeContact)

function contact(fullName: string): Awaited<ReturnType<typeof resolveAttendeeContact>> {
  return { fullName, givenName: '', familyName: '', emails: [], phones: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  owningNoteMock.mockResolvedValue(null)
  contactMock.mockResolvedValue(null)
})

describe('resolveMeetingAttendees', () => {
  it('renames an attendee to the note that owns their invite email', async () => {
    owningNoteMock.mockResolvedValue('Jane Doe')
    const resolved = await resolveMeetingAttendees(
      [{ name: 'jane@corp.com', email: 'jane@corp.com' }],
      false,
    )
    expect(resolved).toEqual([{ name: 'Jane Doe', email: 'jane@corp.com' }])
  })

  it('the graph outranks Apple Contacts — a note owner wins even with the gate on', async () => {
    owningNoteMock.mockResolvedValue('Jane Doe')
    contactMock.mockResolvedValue(contact('Jane A. Doe'))
    const resolved = await resolveMeetingAttendees(
      [{ name: 'jane@corp.com', email: 'jane@corp.com' }],
      true,
    )
    expect(resolved).toEqual([{ name: 'Jane Doe', email: 'jane@corp.com' }])
    expect(contactMock).not.toHaveBeenCalled()
  })

  it('names an email-only attendee from Apple Contacts when no note owns the address', async () => {
    contactMock.mockResolvedValue(contact('Jane Doe'))
    const resolved = await resolveMeetingAttendees(
      [{ name: 'Jane@Corp.com', email: 'jane@corp.com' }],
      true,
    )
    expect(resolved).toEqual([{ name: 'Jane Doe', email: 'jane@corp.com' }])
  })

  it('leaves a calendar-named attendee alone — contacts only fill in for a bare address', async () => {
    contactMock.mockResolvedValue(contact('Jane Doe'))
    const resolved = await resolveMeetingAttendees(
      [{ name: 'Doe, Jane', email: 'jane@corp.com' }],
      true,
    )
    expect(resolved).toEqual([{ name: 'Doe, Jane', email: 'jane@corp.com' }])
    expect(contactMock).not.toHaveBeenCalled()
  })

  it('never reaches Contacts while the gate is off', async () => {
    const resolved = await resolveMeetingAttendees(
      [{ name: 'jane@corp.com', email: 'jane@corp.com' }],
      false,
    )
    expect(resolved).toEqual([{ name: 'jane@corp.com', email: 'jane@corp.com' }])
    expect(contactMock).not.toHaveBeenCalled()
  })

  it('passes attendees without an email straight through, no lookups', async () => {
    const resolved = await resolveMeetingAttendees([{ name: 'Grace Hopper' }], true)
    expect(resolved).toEqual([{ name: 'Grace Hopper' }])
    expect(owningNoteMock).not.toHaveBeenCalled()
    expect(contactMock).not.toHaveBeenCalled()
  })

  it('skips an owner whose title cannot be wiki-linked verbatim', async () => {
    // `[[Jane [Doe]]]` would corrupt the link, and the sanitized form would
    // miss the owner in the index — so the rename must not happen at all.
    owningNoteMock.mockResolvedValue('Jane [Doe]')
    contactMock.mockResolvedValue(contact('Jane Doe'))
    const resolved = await resolveMeetingAttendees(
      [{ name: 'jane@corp.com', email: 'jane@corp.com' }],
      true,
    )
    expect(resolved).toEqual([{ name: 'Jane Doe', email: 'jane@corp.com' }])
  })

  it('falls through on a nameless contact or blank-titled owner', async () => {
    owningNoteMock.mockResolvedValue('   ')
    contactMock.mockResolvedValue(contact('  '))
    const resolved = await resolveMeetingAttendees(
      [{ name: 'jane@corp.com', email: 'jane@corp.com' }],
      true,
    )
    expect(resolved).toEqual([{ name: 'jane@corp.com', email: 'jane@corp.com' }])
  })
})
