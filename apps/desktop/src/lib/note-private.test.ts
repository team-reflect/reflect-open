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

const { toggleNotePrivate } = await import('./note-private')

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockClear()
  openSession.mockReset()
  openSession.mockReturnValue(null)
})

function fakeSession(content: string, canCommit = true) {
  const commitFrontmatter = vi.fn(async () => canCommit)
  const session = { content: () => content, commitFrontmatter } as unknown as NoteSession
  return { session, commitFrontmatter }
}

describe('toggleNotePrivate', () => {
  it('marks an unopened note private via read-patch-write on disk', async () => {
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n# A\n', 3)
  })

  it('un-marks on disk by removing the key (back to no frontmatter)', async () => {
    readNote.mockResolvedValue('---\nprivate: true\n---\n# A\n')
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(false)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('treats the YAML 1.1-style `private: yes` as private and un-marking clears it', async () => {
    // A 1.2 loader reads `yes` as a string; the schema's coercion still
    // honours it, so the toggle must too — re-marking would be a silent no-op.
    readNote.mockResolvedValue('---\nprivate: yes\n---\n# A\n')
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(false)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('replaces an explicit `private: false` with `private: true` when toggling on', async () => {
    readNote.mockResolvedValue('---\nprivate: false\n---\n# A\n')
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n# A\n', 3)
  })

  it('routes through the live session, which owns landing the patch', async () => {
    const { session, commitFrontmatter } = fakeSession('# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(true)
    expect(commitFrontmatter).toHaveBeenCalledWith({ private: true })
    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('toggles off through the session when the open note is private', async () => {
    const { session, commitFrontmatter } = fakeSession('---\nprivate: true\n---\n# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(false)
    expect(commitFrontmatter).toHaveBeenCalledWith({ private: false })
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { session } = fakeSession('# A\n', false)
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePrivate('notes/a.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n# A\n', 3)
  })

  it('marks a not-yet-created note private by creating its file (the lazy contract)', async () => {
    const { session } = fakeSession('', false)
    openSession.mockReturnValue(session)
    readNote.mockRejectedValue({ kind: 'notFound', message: 'no such note' })
    await expect(toggleNotePrivate('daily/2026-06-10.md', 3)).resolves.toBe(true)
    expect(writeNote).toHaveBeenCalledWith('daily/2026-06-10.md', '---\nprivate: true\n---\n', 3)
  })

  it('still surfaces non-notFound read failures', async () => {
    openSession.mockReturnValue(null)
    readNote.mockRejectedValue({ kind: 'io', message: 'disk on fire' })
    await expect(toggleNotePrivate('notes/a.md', 3)).rejects.toMatchObject({ kind: 'io' })
    expect(writeNote).not.toHaveBeenCalled()
  })
})
