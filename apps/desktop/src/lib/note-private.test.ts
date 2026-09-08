import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { queryKeys } from '@/lib/query-client'
import { createNoteSession } from '@/editor/note-session'
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

let client: QueryClient
const operationFail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations', () => ({ startOperation: () => ({ fail: operationFail }) }))

function input(path = 'notes/a.md') {
  return { queryClient: client, root: '/g', generation: 3, path }
}

beforeEach(() => {
  client = new QueryClient()
  operationFail.mockClear()
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

describe('toggleNotePrivate', () => {
  it('marks an unopened note private via read-patch-write on disk', async () => {
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n# A\n', 3)
  })

  it('un-marks on disk by removing the key (back to no frontmatter)', async () => {
    readNote.mockResolvedValue('---\nprivate: true\n---\n# A\n')
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('treats the YAML 1.1-style `private: yes` as private and un-marking clears it', async () => {
    // A 1.2 loader reads `yes` as a string; the schema's coercion still
    // honours it, so the toggle must too — re-marking would be a silent no-op.
    readNote.mockResolvedValue('---\nprivate: yes\n---\n# A\n')
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('replaces an explicit `private: false` with `private: true` when toggling on', async () => {
    readNote.mockResolvedValue('---\nprivate: false\n---\n# A\n')
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n# A\n', 3)
  })

  it('routes through the live session, which owns landing the patch', async () => {
    const { session, commitFrontmatter } = fakeSession('# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(commitFrontmatter).toHaveBeenCalledWith({ private: true })
    expect(readNote).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('toggles off through the session when the open note is private', async () => {
    const { session, commitFrontmatter } = fakeSession('---\nprivate: true\n---\n# A\n')
    openSession.mockReturnValue(session)
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(commitFrontmatter).toHaveBeenCalledWith({ private: false })
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { session } = fakeSession('# A\n', false)
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue('# A\n')
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '---\nprivate: true\n---\n# A\n', 3)
  })

  it('marks a not-yet-created note private by creating its file (the lazy contract)', async () => {
    // Still-loading session: `liveContent` is null, so the read falls to disk.
    const { session } = fakeSession('', false, null)
    openSession.mockReturnValue(session)
    readNote.mockRejectedValue({ kind: 'notFound', message: 'no such note' })
    await expect(toggleNotePrivate(input('daily/2026-06-10.md'))).resolves.toBeUndefined()
    expect(writeNote).toHaveBeenCalledWith('daily/2026-06-10.md', '---\nprivate: true\n---\n', 3)
  })

  it('reports non-notFound read failures through operations', async () => {
    openSession.mockReturnValue(null)
    readNote.mockRejectedValue({ kind: 'io', message: 'disk on fire' })
    await expect(toggleNotePrivate(input())).resolves.toBeUndefined()
    expect(writeNote).not.toHaveBeenCalled()
    expect(operationFail).toHaveBeenCalledExactlyOnceWith('disk on fire')
  })
})

function cachedRow(): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    hasConflict: false,
    gistUrl: 'https://gist.example/1',
    gistStale: false,
  }
}

describe('privacy feedback', () => {
  it('updates shared privacy before saving, cancels an old row request, and ignores duplicate input', async () => {
    const queryKey = queryKeys.index.note('/g', 'notes/a.md')
    const previous = cachedRow()
    client.setQueryData(queryKey, previous)
    const stale = Promise.withResolvers<NoteRow>()
    const request = client.fetchQuery({ queryKey, queryFn: () => stale.promise }).catch(() => null)
    const write = Promise.withResolvers<void>()
    readNote.mockResolvedValue('# A\n')
    writeNote.mockReturnValueOnce(write.promise)

    const action = toggleNotePrivate(input())
    await vi.waitFor(() => expect(writeNote).toHaveBeenCalledOnce())
    expect(client.getQueryData(queryKey)).toEqual({ ...previous, isPrivate: true })
    await toggleNotePrivate(input())
    expect(writeNote).toHaveBeenCalledOnce()
    stale.resolve(previous)
    await request
    expect(client.getQueryData<NoteRow>(queryKey)?.isPrivate).toBe(true)
    write.resolve()
    await action
  })

  it('corrects a stale privacy prediction using the actual file', async () => {
    const queryKey = queryKeys.index.note('/g', 'notes/a.md')
    client.setQueryData(queryKey, cachedRow())
    readNote.mockResolvedValue('---\nprivate: true\n---\n# A\n')
    await toggleNotePrivate(input())
    expect(client.getQueryData<NoteRow>(queryKey)?.isPrivate).toBe(false)
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', '# A\n', 3)
  })

  it('reports a real session write failure, preserves typed text, and allows retry', async () => {
    const queryKey = queryKeys.index.note('/g', 'notes/a.md')
    client.setQueryData(queryKey, cachedRow())
    const write = Promise.withResolvers<void>()
    const writeStarted = Promise.withResolvers<void>()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = createNoteSession({
      path: 'notes/a.md',
      io: {
        read: async () => '# A\n',
        write: () => {
          writeStarted.resolve()
          return write.promise
        },
      },
      classify: () => 'exact',
      applyContent: () => {},
      onSnapshot: () => {},
    })
    try {
      session.load()
      await vi.waitFor(() => expect(session.liveContent()).toBe('# A\n'))
      openSession.mockReturnValue(session)
      const action = toggleNotePrivate(input())
      await writeStarted.promise
      session.editorChanged('# Typed while locking\n')
      write.reject(new Error('disk full'))
      await action
      expect(operationFail).toHaveBeenCalledExactlyOnceWith('disk full')
      expect(session.content()).toBe('# Typed while locking\n')
      expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true)
      // The next attempt must reach the writer again, rather than stay guarded.
      session.discard()
      openSession.mockReturnValue(null)
      readNote.mockResolvedValue('# A\n')
      await toggleNotePrivate(input())
      expect(writeNote).toHaveBeenCalledOnce()
    } finally {
      session.discard()
      consoleError.mockRestore()
    }
  })
})
