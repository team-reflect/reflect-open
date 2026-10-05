import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readNote, writeNote } from '@reflect/core'
import { createNoteSession, type NoteSessionSnapshot } from '@/editor/note-session.ts'
import { registerOpenDocument } from '@/editor/open-documents.ts'
import { commitCaptureDaily } from './capture-daily.ts'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))

const PATH = 'daily/2026-09-22.md'
const ORIGINAL = '+ [x] Existing task\n'
const appendLink = (source: string): string => `${source}\n- [[saved-article]]\n`
const cleanups: Array<() => void> = []
let disk: string | null = ORIGINAL

beforeEach(() => {
  vi.resetAllMocks()
  disk = ORIGINAL
  vi.mocked(readNote).mockImplementation(async () => {
    if (disk === null) throw { kind: 'notFound', message: 'missing' }
    return disk
  })
  vi.mocked(writeNote).mockImplementation(async (_path, content, _generation, expected) => {
    if (expected !== disk) throw new Error('stale write')
    disk = content
  })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function openDaily() {
  const snapshots: NoteSessionSnapshot[] = []
  const session = createNoteSession({
    path: PATH,
    io: {
      read: readNote,
      write: (path, content, expected) => writeNote(path, content, 3, expected),
    },
    classify: () => 'exact',
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    applyContent: () => {},
    saveDebounceMs: 60_000,
  })
  const unregister = registerOpenDocument({ session })
  cleanups.push(() => {
    session.discard()
    unregister()
  })
  session.load()
  return { session, snapshots }
}

it('preserves unsaved typing when a capture edits the open daily note', async () => {
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  session.editorChanged(`${ORIGINAL}+ [ ] Still typing\n`)
  await commitCaptureDaily(PATH, 3, appendLink)
  expect(disk).toBe(appendLink(`${ORIGINAL}+ [ ] Still typing\n`))
  expect(session.content()).toBe(disk)
  expect(snapshots.at(-1)).toMatchObject({ dirty: false, conflict: null })
  expect(readNote).toHaveBeenCalledOnce()
})

it('uses a document opened while the disk fallback was reading', async () => {
  const reading = Promise.withResolvers<string>()
  vi.mocked(readNote).mockReturnValueOnce(reading.promise)
  const capture = commitCaptureDaily(PATH, 3, appendLink)
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  session.editorChanged(`${ORIGINAL}+ [ ] Typed after opening\n`)
  reading.resolve(ORIGINAL)
  await capture
  expect(disk).toBe(appendLink(`${ORIGINAL}+ [ ] Typed after opening\n`))
  expect(session.content()).toBe(disk)
})

it('refuses a loading document instead of replacing its disk file', async () => {
  const reading = Promise.withResolvers<string>()
  vi.mocked(readNote).mockReturnValueOnce(reading.promise)
  openDaily()
  await expect(commitCaptureDaily(PATH, 3, appendLink)).rejects.toThrow('capture remains queued')
  expect(writeNote).not.toHaveBeenCalled()
  reading.resolve(ORIGINAL)
})

it('refuses a conflicted document without falling back to a disk overwrite', async () => {
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  session.editorChanged('+ [ ] My edit\n')
  disk = '- [[remote-link]]\n'
  session.externalChanged()
  await vi.waitFor(() => expect(snapshots.at(-1)?.conflict).toBe(disk))
  await expect(commitCaptureDaily(PATH, 3, appendLink)).rejects.toThrow('capture remains queued')
  expect(writeNote).not.toHaveBeenCalled()
  expect(disk).toBe('- [[remote-link]]\n')
})

it.each([null, ''])(
  'checks the exact disk baseline for a closed daily note: %s',
  async (source) => {
    disk = source
    await commitCaptureDaily(PATH, 3, appendLink)
    expect(writeNote).toHaveBeenCalledWith(PATH, appendLink(''), 3, source)
  },
)

it('rejects a disk change between reading and committing a capture', async () => {
  vi.mocked(readNote).mockImplementationOnce(async () => {
    disk = '- [[remote-link]]\n'
    return ORIGINAL
  })
  await expect(commitCaptureDaily(PATH, 3, appendLink)).rejects.toThrow('stale write')
  expect(disk).toBe('- [[remote-link]]\n')
})

it('rejects a capture when an incoming conflict pauses its queued save', async () => {
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  session.editorChanged(`${ORIGINAL}+ [ ] Unsaved typing\n`)
  const reading = Promise.withResolvers<string>()
  vi.mocked(readNote).mockReturnValueOnce(reading.promise)
  session.externalChanged()
  disk = '- [[remote-link]]\n'
  reading.resolve(disk)
  await expect(commitCaptureDaily(PATH, 3, appendLink)).rejects.toThrow(
    'before the edit could be saved',
  )
  expect(writeNote).not.toHaveBeenCalled()
  expect(session.content()).toBe(`${ORIGINAL}+ [ ] Unsaved typing\n`)
  expect(snapshots.at(-1)?.conflict).toBe(disk)
})

it('does not treat an earlier in-flight save as persisting a later capture', async () => {
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  const writing = Promise.withResolvers<void>()
  vi.mocked(writeNote).mockImplementationOnce(async () => await writing.promise)
  session.editorChanged(`${ORIGINAL}+ [ ] Unsaved typing\n`)
  const flush = session.flush()
  await vi.waitFor(() => expect(writeNote).toHaveBeenCalledOnce())
  const capture = commitCaptureDaily(PATH, 3, appendLink)
  const rejected = expect(capture).rejects.toThrow('before the edit could be saved')
  disk = '- [[remote-link]]\n'
  session.externalChanged()
  await vi.waitFor(() => expect(snapshots.at(-1)?.conflict).toBe(disk))
  writing.resolve()
  await flush
  await rejected
  expect(writeNote).toHaveBeenCalledOnce()
  expect(disk).toBe('- [[remote-link]]\n')
})

it('refuses a daily document being deleted', async () => {
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  await session.prepareDelete()
  await expect(commitCaptureDaily(PATH, 3, appendLink)).rejects.toThrow('capture remains queued')
  expect(writeNote).not.toHaveBeenCalled()
  expect(session.content()).toBe(ORIGINAL)
})

it('does not edit a new graph session after a graph switch during the read', async () => {
  const reading = Promise.withResolvers<string>()
  vi.mocked(readNote).mockReturnValueOnce(reading.promise)
  let stale = false
  const capture = commitCaptureDaily(PATH, 3, appendLink, () => stale)
  const { session, snapshots } = openDaily()
  await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
  stale = true
  reading.resolve(ORIGINAL)
  await expect(capture).rejects.toThrow('Capture graph session changed')
  expect(writeNote).not.toHaveBeenCalled()
  expect(session.content()).toBe(ORIGINAL)
})
