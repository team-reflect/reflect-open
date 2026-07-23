import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOrCreateNoteWithTitle } from '../graph/create-note'
import { setBridge } from '../ipc/bridge'
import { getWikiAddressForPath } from '../indexing/queries-suggestions'
import { ensurePersonNote, resolvePerson } from './person'

vi.mock('../graph/create-note', () => ({
  resolveOrCreateNoteWithTitle: vi.fn(),
}))
vi.mock('../indexing/queries-suggestions', () => ({
  getWikiAddressForPath: vi.fn(),
}))

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
const getAddressMock = vi.mocked(getWikiAddressForPath)
const resolveOrCreateMock = vi.mocked(resolveOrCreateNoteWithTitle)

function address(path = 'notes/ada.md') {
  return {
    target: 'Ada Lovelace',
    path,
    title: 'Ada Lovelace',
    alias: null,
    date: null,
    insertText: 'Ada Lovelace',
  }
}

beforeEach(() => {
  mockInvoke.mockReset()
  getAddressMock.mockReset()
  resolveOrCreateMock.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('resolvePerson', () => {
  it('returns missing without querying for blank identities', async () => {
    await expect(resolvePerson([' ', 'mailto: '])).resolves.toEqual({
      kind: 'missing',
      emails: [],
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('queries all canonical emails and reuses one owner', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/ada.md', title: 'Ada Lovelace' },
    ])
    getAddressMock.mockResolvedValue(address())

    await expect(
      resolvePerson([
        'Ada <ADA@example.com>',
        'ada@example.com',
        'work@example.com',
      ]),
    ).resolves.toEqual({
      kind: 'existing',
      emails: ['ada@example.com', 'work@example.com'],
      path: 'notes/ada.md',
      title: 'Ada Lovelace',
      insertText: 'Ada Lovelace',
    })

    const [, args] = mockInvoke.mock.calls[0]!
    expect(String(args['sql'])).toContain('note_emails')
    expect(String(args['sql'])).toContain('tags')
    expect(String(args['sql'])).not.toContain('limit')
    expect(args['params']).toEqual([
      'ada@example.com',
      'work@example.com',
      'person',
      'note',
    ])
  })

  it('deduplicates one owner found through several emails', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/ada.md', title: 'Ada Lovelace' },
      { path: 'notes/ada.md', title: 'Ada Lovelace' },
    ])
    getAddressMock.mockResolvedValue(address())

    await expect(
      resolvePerson(['ada@example.com', 'work@example.com']),
    ).resolves.toMatchObject({
      kind: 'existing',
      path: 'notes/ada.md',
    })
  })

  it('blocks when the email union has several owners', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/ada.md', title: 'Ada' },
      { path: 'notes/augusta.md', title: 'Augusta' },
    ])

    await expect(
      resolvePerson(['ada@example.com', 'work@example.com']),
    ).resolves.toEqual({
      kind: 'blocked',
      emails: ['ada@example.com', 'work@example.com'],
      reason: 'identity-conflict',
    })
    expect(getAddressMock).not.toHaveBeenCalled()
  })

  it('blocks a unique owner without a safe wiki address', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/ada.md', title: 'Ada Lovelace' },
    ])
    getAddressMock.mockResolvedValue(null)

    await expect(resolvePerson(['ada@example.com'])).resolves.toEqual({
      kind: 'blocked',
      emails: ['ada@example.com'],
      reason: 'unaddressable-owner',
    })
  })
})

describe('ensurePersonNote', () => {
  it('does not create when an owner already exists', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/ada.md', title: 'Ada Lovelace' },
    ])
    getAddressMock.mockResolvedValue(address())

    await expect(
      ensurePersonNote({
        title: 'Ada',
        emails: ['ada@example.com'],
        generation: 7,
      }),
    ).resolves.toMatchObject({ kind: 'existing', path: 'notes/ada.md' })
    expect(resolveOrCreateMock).not.toHaveBeenCalled()
  })

  it('does not create a conflicted identity', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/ada.md', title: 'Ada' },
      { path: 'notes/augusta.md', title: 'Augusta' },
    ])

    await expect(
      ensurePersonNote({
        title: 'Ada',
        emails: ['ada@example.com'],
        generation: 7,
      }),
    ).resolves.toMatchObject({ kind: 'blocked' })
    expect(resolveOrCreateMock).not.toHaveBeenCalled()
  })

  it('creates a missing identity with its initial body', async () => {
    mockInvoke.mockResolvedValue([])
    resolveOrCreateMock.mockResolvedValue({
      kind: 'created',
      path: 'notes/ada.md',
    })

    await expect(
      ensurePersonNote({
        title: 'Ada',
        emails: ['ada@example.com'],
        body: '- Type: #person\n- Email: ada@example.com',
        generation: 7,
      }),
    ).resolves.toEqual({ kind: 'created', path: 'notes/ada.md' })
    expect(resolveOrCreateMock).toHaveBeenCalledWith(
      'Ada',
      7,
      '- Type: #person\n- Email: ada@example.com',
    )
  })
})
