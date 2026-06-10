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

const { toggleNotePinned } = await import('./note-pin')

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockClear()
  openSession.mockReset()
  openSession.mockReturnValue(null)
})

function fakeSession(content: string, { canPatch = true, conflicted = false } = {}) {
  const updateFrontmatter = vi.fn(() => canPatch)
  const flush = vi.fn(async () => {})
  const externalChanged = vi.fn()
  const session = {
    content: () => content,
    updateFrontmatter,
    flush,
    externalChanged,
    conflicted: () => conflicted,
  } as unknown as NoteSession
  return { session, updateFrontmatter, flush, externalChanged }
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

  it('routes through the live session and flushes, never racing the disk', async () => {
    const { session, updateFrontmatter, flush } = fakeSession('# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(true)
    expect(updateFrontmatter).toHaveBeenCalledWith({ pinned: true })
    expect(flush).toHaveBeenCalled()
    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('toggles off through the session when the open note is pinned', async () => {
    const { session, updateFrontmatter } = fakeSession('---\npinned: true\n---\n# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(false)
    expect(updateFrontmatter).toHaveBeenCalledWith({ pinned: false })
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { session } = fakeSession('# A\n', { canPatch: false })
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\npinned: true\n---\n# A\n', 3)
  })

  it('pins a not-yet-created note by creating its file (the lazy contract)', async () => {
    // ⌘O on a fresh daily whose pane session is still loading: the session
    // can't take the patch and the file doesn't exist — a missing note reads
    // as empty, and the pin write is what creates it.
    const { session } = fakeSession('', { canPatch: false })
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

  it('under a parked conflict, also patches disk so the pin is indexed now', async () => {
    // The session's saves are paused (flush is a no-op) — the in-memory patch
    // alone would leave the sidebar stale and "load theirs" would drop the pin.
    const { session, updateFrontmatter, externalChanged } = fakeSession('# Mine\n', {
      conflicted: true,
    })
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue('# Theirs\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(true)
    expect(updateFrontmatter).toHaveBeenCalledWith({ pinned: true })
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\npinned: true\n---\n# Theirs\n', 3)
    // The parked snapshot must refresh from the patched disk content right
    // away — an instant "load theirs" can't race the watcher's echo.
    expect(externalChanged).toHaveBeenCalled()
    expect(externalChanged.mock.invocationCallOrder[0]).toBeGreaterThan(
      writeNote.mock.invocationCallOrder[0],
    )
  })

  it('applies the session-derived target to a conflicted disk, never re-toggling it', async () => {
    // Unpinning while disk already has no flag: nothing to write — a blind
    // disk-side toggle would have *pinned* the contested content instead.
    const { session } = fakeSession('---\npinned: true\n---\n# Mine\n', { conflicted: true })
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue('# Theirs\n')
    await expect(toggleNotePinned('notes/a.md', 3)).resolves.toBe(false)
    expect(writeNote).not.toHaveBeenCalled()
  })
})
