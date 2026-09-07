import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNoteSession,
  type NoteSession,
  type NoteSessionSnapshot,
} from '@/editor/note-session'
import { deleteOpenNote } from './note-delete'

/**
 * `deleteOpenNote` discards an unpersisted note locally. Persisted notes are
 * deleted first, then their session is discarded — so a failed delete never
 * leaves a discarded-but-mounted session (which would silently stop
 * persisting the user's edits).
 */

const deleteNoteMock = vi.fn<(path: string, generation: number) => Promise<void>>()
const isDailyMock = vi.fn<(path: string) => boolean>()
const discard = vi.fn()
const openSessionMock = vi.fn<(path: string) => NoteSession | null>()

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  deleteNote: (path: string, generation: number) => deleteNoteMock(path, generation),
  isDaily: (path: string) => isDailyMock(path),
}))
vi.mock('@/editor/open-documents', () => ({
  openSession: (path: string) => openSessionMock(path),
}))

afterEach(() => {
  deleteNoteMock.mockReset()
  isDailyMock.mockReset().mockReturnValue(false)
  discard.mockReset()
  openSessionMock.mockReset()
})

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferred(): Deferred {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function lazySession(write: (path: string, contents: string) => Promise<void>): {
  readonly session: NoteSession
  readonly snapshots: NoteSessionSnapshot[]
} {
  const snapshots: NoteSessionSnapshot[] = []
  const session = createNoteSession({
    path: 'notes/new.md',
    io: {
      read: async () => {
        throw { kind: 'notFound', message: 'missing' }
      },
      write,
    },
    classify: () => 'exact',
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    applyContent: () => {},
    createIfMissing: true,
    missingSeed: '#\n',
    saveDebounceMs: 10,
  })
  return { session, snapshots }
}

describe('deleteOpenNote', () => {
  it('waits for a new note to load, then discards it without deleting a missing file', async () => {
    const { session } = lazySession(async () => {})
    const discardSpy = vi.spyOn(session, 'discard')
    openSessionMock.mockReturnValue(session)
    session.load()

    await deleteOpenNote('notes/new.md', 3)

    expect(deleteNoteMock).not.toHaveBeenCalled()
    expect(discardSpy).toHaveBeenCalledOnce()
  })

  it("waits for a new note's in-flight first write before deleting its file", async () => {
    const writeStarted = deferred()
    const allowWrite = deferred()
    let fileExists = false
    const { session, snapshots } = lazySession(async () => {
      writeStarted.resolve()
      await allowWrite.promise
      fileExists = true
    })
    openSessionMock.mockReturnValue(session)
    deleteNoteMock.mockImplementation(async () => {
      if (!fileExists) {
        throw new Error('no such file or directory')
      }
      fileExists = false
    })
    session.load()
    await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
    session.editorChanged('# Draft\n')
    const flush = session.flush()
    await writeStarted.promise

    const deletion = deleteOpenNote('notes/new.md', 3)
    await Promise.resolve()
    expect(deleteNoteMock).not.toHaveBeenCalled()

    allowWrite.resolve()
    await Promise.all([flush, deletion])

    expect(deleteNoteMock).toHaveBeenCalledWith('notes/new.md', 3)
    expect(fileExists).toBe(false)
  })

  it('discards the open session after a successful delete', async () => {
    deleteNoteMock.mockResolvedValue()
    openSessionMock.mockReturnValue({
      prepareDelete: async () => false,
      discard,
    } as unknown as NoteSession)

    await deleteOpenNote('notes/gone.md', 3)

    expect(deleteNoteMock).toHaveBeenCalledWith('notes/gone.md', 3)
    expect(discard).toHaveBeenCalledOnce()
  })

  it('leaves the session intact when the delete fails', async () => {
    deleteNoteMock.mockRejectedValue(new Error('disk full'))
    const cancelDelete = vi.fn()
    openSessionMock.mockReturnValue({
      prepareDelete: async () => false,
      cancelDelete,
      discard,
    } as unknown as NoteSession)

    await expect(deleteOpenNote('notes/gone.md', 3)).rejects.toThrow('disk full')

    // The session was never discarded — the screen stays editable.
    expect(discard).not.toHaveBeenCalled()
    expect(cancelDelete).toHaveBeenCalledOnce()
    expect(openSessionMock).toHaveBeenCalledOnce()
  })

  it('rejects daily notes without touching disk', async () => {
    isDailyMock.mockReturnValue(true)

    await expect(deleteOpenNote('daily/2026-06-10.md', 3)).rejects.toThrow(
      'Daily notes cannot be deleted',
    )

    expect(deleteNoteMock).not.toHaveBeenCalled()
    expect(openSessionMock).not.toHaveBeenCalled()
  })
})
