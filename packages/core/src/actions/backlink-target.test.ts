import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readNote } from '../graph/commands'
import { resolveOrCreateNoteWithTitle } from '../graph/create-note'
import { ensureBacklinkTarget } from './backlink-target'

vi.mock('../graph/commands', () => ({ readNote: vi.fn() }))
vi.mock('../graph/create-note', () => ({ resolveOrCreateNoteWithTitle: vi.fn() }))

const readNoteMock = vi.mocked(readNote)
const resolveOrCreateMock = vi.mocked(resolveOrCreateNoteWithTitle)

beforeEach(() => {
  vi.clearAllMocks()
  resolveOrCreateMock.mockResolvedValue({ kind: 'resolved', path: 'notes/links.md' })
  readNoteMock.mockResolvedValue('# Links\n')
})

describe('ensureBacklinkTarget', () => {
  it('returns the existing note title so renamed categories keep one section', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'resolved', path: 'notes/bookmarks.md' })
    readNoteMock.mockResolvedValue('# Bookmarks\n')

    await expect(ensureBacklinkTarget('Links', 3)).resolves.toBe('Bookmarks')
    expect(readNoteMock).toHaveBeenCalledWith('notes/bookmarks.md', 3)
  })

  it('returns the canonical title of a newly created target', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'created', path: 'notes/links.md' })

    await expect(ensureBacklinkTarget('Links', 3)).resolves.toBe('Links')
  })

  it('keeps the resolvable alias when the current title is unsafe in wiki syntax', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'resolved', path: 'notes/saved-links.md' })
    readNoteMock.mockResolvedValue('# Saved | Links\n')

    await expect(ensureBacklinkTarget('Links', 3)).resolves.toBe('Links')
  })

  it('uses the read-only wiki-link winner when duplicate targets already exist', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/links.md', 'notes/links-2.md'],
    })

    await expect(ensureBacklinkTarget('Links', 3)).resolves.toBe('Links')
    expect(readNoteMock).toHaveBeenCalledWith('notes/links-2.md', 3)
  })

  it('links directly to the selected duplicate when its current title is unique', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/saved-links.md', 'notes/bookmarks.md'],
    })
    readNoteMock.mockResolvedValue('# Bookmarks\n')

    await expect(ensureBacklinkTarget('Links', 3)).resolves.toBe('Bookmarks')
    expect(readNoteMock).toHaveBeenCalledWith('notes/bookmarks.md', 3)
  })

  it('keeps a duplicate target retryable when the selected winner cannot be read', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/links.md', 'notes/links-2.md'],
    })
    readNoteMock.mockRejectedValue({ kind: 'io', message: 'not downloaded' })

    await expect(ensureBacklinkTarget('Links', 3)).rejects.toMatchObject({
      kind: 'io',
      message: 'not downloaded',
    })
    expect(readNoteMock).toHaveBeenCalledTimes(1)
    expect(readNoteMock).toHaveBeenCalledWith('notes/links-2.md', 3)
  })

  it('keeps the requested spelling when a matching note is unavailable', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'unavailable',
      paths: ['notes/links.md'],
    })

    await expect(ensureBacklinkTarget('Links', 3)).resolves.toBe('Links')
    expect(readNoteMock).not.toHaveBeenCalled()
  })

  it('rejects an impossible ambiguous result without any target paths', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'ambiguous', paths: [] })

    await expect(ensureBacklinkTarget('Links', 3)).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('could not be resolved'),
    })
    expect(readNoteMock).not.toHaveBeenCalled()
  })
})
