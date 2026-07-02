import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteSession } from '@/editor/note-session'

const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNote = vi.hoisted(() => vi.fn(async () => {}))
const indexNote = vi.hoisted(() => vi.fn(async () => {}))
const openSession = vi.hoisted(() => vi.fn<(path: string) => NoteSession | null>(() => null))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
  indexNote,
}))
vi.mock('@/editor/open-documents', () => ({ openSession }))

const { deepLinkForNote } = await import('./note-deep-link')

const ULID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockClear()
  indexNote.mockClear()
  openSession.mockReset()
  openSession.mockReturnValue(null)
})

describe('deepLinkForNote', () => {
  it('addresses a daily note by date, touching nothing', async () => {
    await expect(deepLinkForNote('daily/2026-07-01.md', 3)).resolves.toBe(
      'reflect://daily/2026-07-01',
    )
    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('addresses an impossible-date daily file like a plain note (mints an id)', async () => {
    // `routeForPath` opens daily/2026-02-31.md as a plain note; a date-form
    // link would be one the parser rejects.
    readNote.mockResolvedValue('# Not a real day\n')

    const url = await deepLinkForNote('daily/2026-02-31.md', 3)

    expect(url.startsWith('reflect://note/')).toBe(true)
    expect(writeNote).toHaveBeenCalled()
  })

  it('uses the existing frontmatter id without writing or reindexing', async () => {
    readNote.mockResolvedValue('---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# A\n')

    await expect(deepLinkForNote('notes/a.md', 3)).resolves.toBe(
      'reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw',
    )
    expect(writeNote).not.toHaveBeenCalled()
    expect(indexNote).not.toHaveBeenCalled()
  })

  it('treats a blank frontmatter id as absent and mints a real one', async () => {
    readNote.mockResolvedValue('---\nid: ""\n---\n# A\n')

    const url = await deepLinkForNote('notes/a.md', 3)

    const id = decodeURIComponent(url.replace('reflect://note/', ''))
    expect(id).toMatch(ULID_RE)
    expect(writeNote).toHaveBeenCalled()
  })

  it('mints a ULID id on first copy, lands it on disk, and indexes it immediately', async () => {
    readNote.mockResolvedValue('# A\n')

    const url = await deepLinkForNote('notes/a.md', 3)

    const id = decodeURIComponent(url.replace('reflect://note/', ''))
    expect(id).toMatch(ULID_RE)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', `---\nid: ${id}\n---\n# A\n`, 3)
    // The index trails local writes by a watcher debounce; without this the
    // just-copied link answers "Note not found" until the reindex.
    expect(indexNote).toHaveBeenCalledWith('notes/a.md', { generation: 3 })
  })

  it('still returns the link when the immediate reindex fails', async () => {
    readNote.mockResolvedValue('# A\n')
    indexNote.mockRejectedValueOnce(new Error('index busy'))

    const url = await deepLinkForNote('notes/a.md', 3)

    expect(url.startsWith('reflect://note/')).toBe(true)
  })

  it('mints through the live session when one owns the note', async () => {
    const commitFrontmatter = vi.fn(async () => true)
    openSession.mockReturnValue({
      liveContent: () => '# A\n',
      commitFrontmatter,
    } as unknown as NoteSession)

    const url = await deepLinkForNote('notes/a.md', 3)

    const id = decodeURIComponent(url.replace('reflect://note/', ''))
    expect(commitFrontmatter).toHaveBeenCalledWith({ id })
    expect(writeNote).not.toHaveBeenCalled()
  })
})
