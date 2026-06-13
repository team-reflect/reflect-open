import { afterEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn<(command: string, args: unknown) => Promise<unknown>>()
const readNoteMock = vi.fn<(path: string) => Promise<string>>()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: (path: string) => readNoteMock(path),
}))

afterEach(() => {
  invokeMock.mockReset()
  readNoteMock.mockReset()
})

describe('shareNote', () => {
  it('shares the body (frontmatter stripped) with the title as subject', async () => {
    readNoteMock.mockResolvedValue('---\nid: abc123\n---\n# Meeting\n\nAgenda items.\n')
    invokeMock.mockResolvedValue(undefined)
    const { shareNote } = await import('./share')

    await shareNote('notes/meeting-notes.md')

    expect(readNoteMock).toHaveBeenCalledWith('notes/meeting-notes.md')
    expect(invokeMock).toHaveBeenCalledWith('plugin:sharesheet|share', {
      payload: { text: '# Meeting\n\nAgenda items.\n', title: 'meeting-notes' },
    })
  })
})
