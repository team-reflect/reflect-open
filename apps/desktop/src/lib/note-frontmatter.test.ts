import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteWriteIfUnchangedOutcome } from '@reflect/core'
import type { NoteSession } from '@/editor/note-session'

const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNoteIfUnchanged = vi.hoisted(() =>
  vi.fn<
    (
      path: string,
      expected: string | null,
      contents: string,
      generation: number,
    ) => Promise<NoteWriteIfUnchangedOutcome>
  >(async () => ({ kind: 'written', modifiedMs: null })),
)
const openSession = vi.hoisted(() => vi.fn<(path: string) => NoteSession | null>(() => null))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNoteIfUnchanged,
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
  writeNoteIfUnchanged.mockReset().mockResolvedValue({ kind: 'written', modifiedMs: null })
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
    expect(writeNoteIfUnchanged).not.toHaveBeenCalled()
  })

  it('falls back to a disk patch when the session declines the patch', async () => {
    openSession.mockReturnValue(fakeSession({ live: '# A\n', canCommit: false }).session)
    readNote.mockResolvedValue('# A\n')

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNoteIfUnchanged).toHaveBeenCalledWith(
      'notes/a.md',
      '# A\n',
      '---\npinned: true\n---\n# A\n',
      3,
    )
  })

  it('patches disk directly when no session is open', async () => {
    readNote.mockResolvedValue('# A\n')

    await commitNoteFrontmatter('notes/a.md', { private: true }, 3)

    expect(writeNoteIfUnchanged).toHaveBeenCalledWith(
      'notes/a.md',
      '# A\n',
      '---\nprivate: true\n---\n# A\n',
      3,
    )
  })

  it('writes nothing when the patch changes nothing', async () => {
    readNote.mockResolvedValue('---\npinned: true\n---\n# A\n')

    await commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(writeNoteIfUnchanged).not.toHaveBeenCalled()
  })

  it('does not create an arbitrary missing note from a stale frontmatter action', async () => {
    readNote.mockRejectedValue({ kind: 'notFound', message: 'missing' })

    await expect(
      commitNoteFrontmatter('Projects/deleted.md', { private: true }, 3),
    ).rejects.toMatchObject({ kind: 'notFound' })

    expect(writeNoteIfUnchanged).not.toHaveBeenCalled()
  })

  it('may create a missing daily through an absent-path conditional write', async () => {
    readNote.mockRejectedValue({ kind: 'notFound', message: 'missing' })

    await commitNoteFrontmatter('daily/2026-07-14.md', { pinned: true }, 3)

    expect(writeNoteIfUnchanged).toHaveBeenCalledWith(
      'daily/2026-07-14.md',
      null,
      '---\npinned: true\n---\n',
      3,
    )
  })

  it('fails closed when disk changes after the frontmatter read', async () => {
    readNote.mockResolvedValue('# A\n')
    writeNoteIfUnchanged.mockResolvedValue({ kind: 'changed' })

    await expect(commitNoteFrontmatter('notes/a.md', { pinned: true }, 3)).rejects.toThrow(
      /changed or was removed/,
    )
  })
})
