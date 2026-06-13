import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shareMock = vi.fn<(data: ShareData) => Promise<void>>()
const readNoteMock = vi.fn<(path: string) => Promise<string>>()
const openSessionMock = vi.fn<(path: string) => { liveContent: () => string | null } | null>()

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: (path: string) => readNoteMock(path),
}))
vi.mock('@/editor/open-documents', () => ({
  openSession: (path: string) => openSessionMock(path),
}))

beforeEach(() => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock })
  shareMock.mockReset()
  shareMock.mockResolvedValue(undefined)
  readNoteMock.mockReset()
  openSessionMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shareNote', () => {
  it('prefers the live editor buffer (frontmatter stripped, title as subject)', async () => {
    // A ready session holding unsaved edits the file doesn't have yet.
    openSessionMock.mockReturnValue({
      liveContent: () => '---\nid: abc123\n---\n# Meeting\n\nAgenda + the unsaved line.\n',
    })
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).not.toHaveBeenCalled()
    expect(shareMock).toHaveBeenCalledWith({
      title: 'meeting-notes',
      text: '# Meeting\n\nAgenda + the unsaved line.\n',
    })
  })

  it('reads disk when no session is open', async () => {
    openSessionMock.mockReturnValue(null)
    readNoteMock.mockResolvedValue('---\nid: abc123\n---\n# Meeting\n\nFrom disk.\n')
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).toHaveBeenCalledWith('notes/meeting-notes.md')
    expect(shareMock).toHaveBeenCalledWith({ title: 'meeting-notes', text: '# Meeting\n\nFrom disk.\n' })
  })

  it('reads disk when the open session is still loading (liveContent null)', async () => {
    // A session is registered before its async load() lands; liveContent() is null.
    openSessionMock.mockReturnValue({ liveContent: () => null })
    readNoteMock.mockResolvedValue('---\nid: abc123\n---\n# Meeting\n\nReal content.\n')
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).toHaveBeenCalledWith('notes/meeting-notes.md')
    expect(shareMock).toHaveBeenCalledWith({
      title: 'meeting-notes',
      text: '# Meeting\n\nReal content.\n',
    })
  })

  it('shares the empty live buffer (not stale disk) when a ready note was cleared', async () => {
    // Ready + empty: the user removed the body; share that, not old disk text.
    openSessionMock.mockReturnValue({ liveContent: () => '' })
    readNoteMock.mockResolvedValue('---\nid: abc123\n---\n# Stale on disk.\n')
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).not.toHaveBeenCalled()
    expect(shareMock).toHaveBeenCalledWith({ title: 'meeting-notes', text: '' })
  })
})
