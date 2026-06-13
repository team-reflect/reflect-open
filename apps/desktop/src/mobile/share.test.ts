import { afterEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn<(command: string, args: unknown) => Promise<unknown>>()
const readNoteMock = vi.fn<(path: string) => Promise<string>>()
const openSessionMock = vi.fn<(path: string) => { content: () => string } | null>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: (path: string) => readNoteMock(path),
}))
vi.mock('@/editor/open-documents', () => ({
  openSession: (path: string) => openSessionMock(path),
}))

afterEach(() => {
  invokeMock.mockReset()
  readNoteMock.mockReset()
  openSessionMock.mockReset()
})

describe('shareNote', () => {
  it('shares the disk body (frontmatter stripped) when no session is open', async () => {
    openSessionMock.mockReturnValue(null)
    readNoteMock.mockResolvedValue('---\nid: abc123\n---\n# Meeting\n\nAgenda items.\n')
    invokeMock.mockResolvedValue(undefined)
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).toHaveBeenCalledWith('notes/meeting-notes.md')
    expect(invokeMock).toHaveBeenCalledWith('plugin:sharesheet|share', {
      payload: { text: '# Meeting\n\nAgenda items.\n', title: 'meeting-notes' },
    })
  })

  it('prefers the live editor buffer over disk when a session is open', async () => {
    // The open session holds unsaved edits the file doesn't have yet.
    openSessionMock.mockReturnValue({
      content: () => '---\nid: abc123\n---\n# Meeting\n\nAgenda + the unsaved line.\n',
    })
    readNoteMock.mockResolvedValue('---\nid: abc123\n---\n# Meeting\n\nAgenda items.\n')
    invokeMock.mockResolvedValue(undefined)
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('plugin:sharesheet|share', {
      payload: { text: '# Meeting\n\nAgenda + the unsaved line.\n', title: 'meeting-notes' },
    })
  })
})
