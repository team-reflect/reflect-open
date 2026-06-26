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

const { reorderPinnedNotes, toggleNotePinned, unpinNote } = await import('./note-pin')

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockClear()
  openSession.mockReset()
  openSession.mockReturnValue(null)
})

function fakeSession(content: string, canCommit = true, liveContent: string | null = content) {
  const commitFrontmatter = vi.fn(async () => canCommit)
  const session = {
    content: () => content,
    liveContent: () => liveContent,
    commitFrontmatter,
  } as unknown as NoteSession
  return { session, commitFrontmatter }
}

describe('toggleNotePinned', () => {
  it('pins an unopened note via read-patch-write on disk', async () => {
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\npinned: true\n---\n# A\n', 3)
  })

  it('unpins on disk by removing the key (back to no frontmatter)', async () => {
    readNote.mockResolvedValue('---\npinned: true\n---\n# A\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(false)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('treats an explicit order — including 0 — as pinned, and unpinning clears it', async () => {
    // `pinned: 0` is falsy in JS; a truthiness check would re-pin instead.
    readNote.mockResolvedValue('---\npinned: 0\n---\n# A\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(false)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('routes through the live session, which owns landing the patch', async () => {
    const { session, commitFrontmatter } = fakeSession('# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(true)
    expect(commitFrontmatter).toHaveBeenCalledWith({ pinned: true })
    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('toggles off through the session when the open note is pinned', async () => {
    const { session, commitFrontmatter } = fakeSession('---\npinned: 2\n---\n# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(false)
    expect(commitFrontmatter).toHaveBeenCalledWith({ pinned: false })
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { session } = fakeSession('# A\n', false)
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\npinned: true\n---\n# A\n', 3)
  })

  it('pins a not-yet-created note by creating its file (the lazy contract)', async () => {
    // ⌘O on a fresh daily whose pane session is still loading: `liveContent`
    // is null (the buffer isn't the truth yet) so the read falls to disk, the
    // session can't take the patch, and the file doesn't exist — a missing
    // note reads as empty, and the pin write is what creates it.
    const { session } = fakeSession('', false, null)
    openSession.mockReturnValue(session)
    readNote.mockRejectedValue({ kind: 'notFound', message: 'no such note' })
    await expect(toggleNotePinned('daily/2026-06-10.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('daily/2026-06-10.md', '---\npinned: true\n---\n', 3)
  })

  it('still surfaces non-notFound read failures', async () => {
    openSession.mockReturnValue(null)
    readNote.mockRejectedValue({ kind: 'io', message: 'disk on fire' })
    await expect(toggleNotePinned('notes/a.md', 3)).rejects.toMatchObject({ kind: 'io' })
    expect(writeNote).not.toHaveBeenCalled()
  })
})

describe('unpinNote', () => {
  it('unpins directly without reading the current pin state', async () => {
    readNote.mockResolvedValue('---\npinned: true\n---\n# A\n')

    await unpinNote('notes/a.md', 3)

    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('routes direct unpin through the live session', async () => {
    const { session, commitFrontmatter } = fakeSession('---\npinned: 2\n---\n# A\n')
    openSession.mockReturnValue(session)

    await unpinNote('notes/a.md', 3)

    expect(commitFrontmatter).toHaveBeenCalledWith({ pinned: false })
    expect(readNote).not.toHaveBeenCalled()
  })
})

describe('reorderPinnedNotes', () => {
  it('writes dense numeric pin orders to each pinned note', async () => {
    readNote.mockResolvedValue('# A\n')

    await reorderPinnedNotes(
      [
        { path: 'notes/c.md', title: 'C', dailyDate: null },
        { path: 'notes/a.md', title: 'A', dailyDate: null },
      ],
      3,
    )

    expect(writeNote).toHaveBeenCalledWith('notes/c.md', '---\npinned: 0\n---\n# A\n', 3)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\npinned: 1\n---\n# A\n', 3)
  })

  it('routes open notes through their sessions', async () => {
    const { session, commitFrontmatter } = fakeSession('# A\n')
    openSession.mockReturnValue(session)

    await reorderPinnedNotes([{ path: 'notes/a.md', title: 'A', dailyDate: null }], 3)

    expect(commitFrontmatter).toHaveBeenCalledWith({ pinned: 0 })
    expect(writeNote).not.toHaveBeenCalled()
  })
})
