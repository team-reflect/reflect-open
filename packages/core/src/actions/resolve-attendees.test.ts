import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePerson } from '../contacts/person'
import { resolveAttendeeContact } from '../contacts/resolve'
import {
  resolveMeetingAttendees,
  resolveMeetingAttendeeTargets,
} from './resolve-attendees'

vi.mock('../contacts/person', () => ({
  resolvePerson: vi.fn(),
}))
vi.mock('../contacts/resolve', () => ({
  resolveAttendeeContact: vi.fn(),
}))

const resolvePersonMock = vi.mocked(resolvePerson)
const contactMock = vi.mocked(resolveAttendeeContact)

beforeEach(() => {
  vi.clearAllMocks()
  resolvePersonMock.mockImplementation(async (emails) => ({
    kind: 'missing',
    emails: [...emails],
  }))
  contactMock.mockResolvedValue(null)
})

describe('resolveMeetingAttendees', () => {
  it('renames an attendee to its unique email owner', async () => {
    resolvePersonMock.mockResolvedValue({
      kind: 'existing',
      emails: ['jane@corp.com'],
      path: 'notes/jane.md',
      title: 'Jane Doe',
      insertText: 'Jane Doe',
    })

    await expect(
      resolveMeetingAttendees(
        [{ name: 'jane@corp.com', emails: ['jane@corp.com'] }],
        false,
      ),
    ).resolves.toEqual([
      { name: 'Jane Doe', emails: ['jane@corp.com'] },
    ])
    expect(contactMock).not.toHaveBeenCalled()
  })

  it('uses all Contact emails when a bare address resolves through Contacts', async () => {
    contactMock.mockResolvedValue({
      fullName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      emails: ['jane@corp.com', 'jane@home.example'],
      phones: [],
    })

    await expect(
      resolveMeetingAttendees(
        [{ name: 'Jane@Corp.com', emails: ['jane@corp.com'] }],
        true,
      ),
    ).resolves.toEqual([
      {
        name: 'Jane Doe',
        emails: ['jane@corp.com', 'jane@home.example'],
      },
    ])
    expect(resolvePersonMock).toHaveBeenLastCalledWith([
      'jane@corp.com',
      'jane@home.example',
    ])
  })

  it('keeps a calendar display name while collecting all Contact emails', async () => {
    contactMock.mockResolvedValue({
      fullName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      emails: ['jane@corp.com', 'jane@home.example'],
      phones: [],
    })

    await expect(
      resolveMeetingAttendees(
        [{ name: 'Doe, Jane', emails: ['jane@corp.com'] }],
        true,
      ),
    ).resolves.toEqual([
      {
        name: 'Doe, Jane',
        emails: ['jane@corp.com', 'jane@home.example'],
      },
    ])
    expect(resolvePersonMock).toHaveBeenLastCalledWith([
      'jane@corp.com',
      'jane@home.example',
    ])
  })

  it('keeps a conflicted Contact selectable under its original name', async () => {
    resolvePersonMock.mockResolvedValue({
      kind: 'blocked',
      emails: ['jane@corp.com', 'jane@home.example'],
      reason: 'identity-conflict',
    })

    await expect(
      resolveMeetingAttendees(
        [{
          name: 'Jane Doe',
          emails: ['jane@corp.com', 'jane@home.example'],
        }],
        true,
      ),
    ).resolves.toEqual([
      {
        name: 'Jane Doe',
        emails: ['jane@corp.com', 'jane@home.example'],
      },
    ])
    expect(contactMock).not.toHaveBeenCalled()
  })

  it('blocks when a Contact lookup adds an email owned by another person note', async () => {
    contactMock.mockResolvedValue({
      fullName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      emails: ['jane@corp.com', 'jane@home.example'],
      phones: [],
    })
    resolvePersonMock
      .mockResolvedValueOnce({
        kind: 'missing',
        emails: ['jane@corp.com'],
      })
      .mockResolvedValueOnce({
        kind: 'blocked',
        emails: ['jane@corp.com', 'jane@home.example'],
        reason: 'identity-conflict',
      })

    await expect(
      resolveMeetingAttendeeTargets(
        [{ name: 'jane@corp.com', emails: ['jane@corp.com'] }],
        true,
      ),
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
})

describe('resolveMeetingAttendeeTargets', () => {
  it('links unique owners with their verified address', async () => {
    resolvePersonMock.mockResolvedValue({
      kind: 'existing',
      emails: ['jane@corp.com'],
      path: 'notes/jane.md',
      title: 'Jane Doe',
      insertText: 'Jane|Jane Doe',
    })

    await expect(
      resolveMeetingAttendeeTargets(
        [{ name: 'jane@corp.com', emails: ['jane@corp.com'] }],
        false,
      ),
    ).resolves.toEqual([
      {
        kind: 'existing',
        attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
        insertText: 'Jane|Jane Doe',
      },
    ])
  })

  it.each(['identity-conflict', 'unaddressable-owner'] as const)(
    'writes %s identities as plain text',
    async (reason) => {
      resolvePersonMock.mockResolvedValue({
        kind: 'blocked',
        emails: ['jane@corp.com'],
        reason,
      })

      await expect(
        resolveMeetingAttendeeTargets(
          [{ name: 'Jane Doe', emails: ['jane@corp.com'] }],
          false,
        ),
      ).resolves.toEqual([
        {
          kind: 'plain',
          attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
        },
      ])
    },
  )

  it('returns a safe new target when no email owner exists', async () => {
    await expect(
      resolveMeetingAttendeeTargets(
        [{ name: 'Jane Doe', emails: ['JANE@corp.com'] }],
        false,
      ),
    ).resolves.toEqual([
      {
        kind: 'new',
        attendee: { name: 'Jane Doe', emails: ['jane@corp.com'] },
        insertText: 'Jane Doe',
      },
    ])
  })
})
