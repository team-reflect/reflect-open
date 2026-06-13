import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shareMock = vi.fn<(data: ShareData) => Promise<void>>()
const openSessionMock = vi.fn<(path: string) => { liveContent: () => string | null } | null>()

vi.mock('@/editor/open-documents', () => ({
  openSession: (path: string) => openSessionMock(path),
}))

beforeEach(() => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock })
  shareMock.mockReset()
  shareMock.mockResolvedValue(undefined)
  openSessionMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shareNote', () => {
  it('shares the live editor buffer body (frontmatter stripped, title as subject)', async () => {
    openSessionMock.mockReturnValue({
      liveContent: () => '---\nid: abc123\n---\n# Meeting\n\nAgenda + the unsaved line.\n',
    })
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(shareMock).toHaveBeenCalledWith({
      title: 'meeting-notes',
      text: '# Meeting\n\nAgenda + the unsaved line.\n',
    })
  })

  it('shares the empty body when a ready note was cleared (not stale content)', async () => {
    openSessionMock.mockReturnValue({ liveContent: () => '' })
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(shareMock).toHaveBeenCalledWith({ title: 'meeting-notes', text: '' })
  })

  it('shares empty rather than reading disk while the session is still loading', async () => {
    // liveContent() is null until load() lands; reading disk here would
    // require an await and break navigator.share's transient activation.
    openSessionMock.mockReturnValue({ liveContent: () => null })
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(shareMock).toHaveBeenCalledWith({ title: 'meeting-notes', text: '' })
  })
})
