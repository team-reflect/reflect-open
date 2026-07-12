import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'
import { readExistingNoteSource } from './read-existing-note-source'

vi.mock('@reflect/core', () => ({
  readNote: vi.fn(),
}))

vi.mock('@/editor/open-documents', () => ({
  openSession: vi.fn(),
}))

const readNoteMock = vi.mocked(readNote)
const openSessionMock = vi.mocked(openSession)

describe('readExistingNoteSource', () => {
  beforeEach(() => {
    readNoteMock.mockReset()
    openSessionMock.mockReset().mockReturnValue(null)
  })

  it('reads the live buffer of an open, ready session', async () => {
    openSessionMock.mockReturnValue({ liveContent: () => '# Live' } as never)
    readNoteMock.mockResolvedValue('# On disk')

    await expect(readExistingNoteSource('notes/a.md', 7)).resolves.toBe('# Live')
    expect(readNoteMock).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('preserves an authoritative empty live buffer', async () => {
    openSessionMock.mockReturnValue({ liveContent: () => '' } as never)
    readNoteMock.mockResolvedValue('# On disk')

    await expect(readExistingNoteSource('notes/a.md', 7)).resolves.toBe('')
    expect(readNoteMock).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('refuses a stale live buffer when its generation-pinned file is gone', async () => {
    openSessionMock.mockReturnValue({ liveContent: () => '# Stale' } as never)
    readNoteMock.mockRejectedValue({ kind: 'notFound', message: 'removed' })

    await expect(readExistingNoteSource('notes/a.md', 7)).rejects.toMatchObject({
      kind: 'notFound',
    })
  })

  it('falls back to a generation-pinned disk read while the session is loading', async () => {
    openSessionMock.mockReturnValue({ liveContent: () => null } as never)
    readNoteMock.mockResolvedValue('# On disk')

    await expect(readExistingNoteSource('notes/a.md', 7)).resolves.toBe('# On disk')
    expect(readNoteMock).toHaveBeenCalledWith('notes/a.md', 7)
  })
})
