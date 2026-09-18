import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSession } from '@/editor/note-session'

const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNote = vi.hoisted(() => vi.fn(async () => {}))
const openSession = vi.hoisted(() => vi.fn<(path: string) => NoteSession | null>(() => null))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
}))
vi.mock('@/editor/open-documents', () => ({ openSession }))

const { commitNoteFrontmatter, readNoteSource } = await import('./note-frontmatter')

function fakeSession(options: { live?: string | null; canCommit?: boolean }) {
  const commitFrontmatter = vi.fn(async () => options.canCommit ?? true)
  const session = {
    liveContent: () => options.live ?? null,
    commitFrontmatter,
  } as unknown as NoteSession
  return { session, commitFrontmatter }
}

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockClear()
  openSession.mockReset().mockReturnValue(null)
})

describe('readNoteSource', () => {
  it("reads the open session's loaded buffer, not disk", async () => {
    openSession.mockReturnValue(fakeSession({ live: '# live\n' }).session)
    await expect(readNoteSource('notes/a.md')).resolves.toBe('# live\n')
    expect(readNote).not.toHaveBeenCalled()
  })

  it('falls back to disk while the session is still loading (liveContent null)', async () => {
    openSession.mockReturnValue(fakeSession({ live: null }).session)
    readNote.mockResolvedValue('# disk\n')
    await expect(readNoteSource('notes/a.md')).resolves.toBe('# disk\n')
  })

  it('reads disk when no session is open', async () => {
    readNote.mockResolvedValue('# disk\n')
    await expect(readNoteSource('notes/a.md')).resolves.toBe('# disk\n')
  })
})

describe('commitNoteFrontmatter', () => {
  it('lands the patch through the live session when it can take it', async () => {
    const { session, commitFrontmatter } = fakeSession({ live: '# A\n', canCommit: true })
    openSession.mockReturnValue(session)

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(commitFrontmatter).toHaveBeenCalledWith({ pinned: true })
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('falls back to a disk patch when the session declines the patch', async () => {
    openSession.mockReturnValue(fakeSession({ live: '# A\n', canCommit: false }).session)
    readNote.mockResolvedValue('# A\n')

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\npinned: true\n---\n\n# A\n', 3)
  })

  it('patches disk directly when no session is open', async () => {
    readNote.mockResolvedValue('# A\n')

    await commitNoteFrontmatter('notes/a.md', { private: true }, 3)

    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n\n# A\n', 3)
  })

  it('writes nothing when the patch changes nothing', async () => {
    readNote.mockResolvedValue('---\npinned: true\n---\n\n# A\n')

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNote).not.toHaveBeenCalled()
  })
})
