import { afterEach, expect, it, vi } from 'vitest'
import { createNoteSession, type NoteSession, type NoteSessionSnapshot } from './note-session.ts'

const ORIGINAL = '+ [x] Existing task\n'
const CAPTURED = `${ORIGINAL}\n## [[Links]]\n\n- [[capture-example|Saved article]]\n`
const sessions: NoteSession[] = []

function harness() {
  let disk = ORIGINAL
  const read = vi.fn(async (_path: string) => disk)
  const write = vi.fn(async (_path: string, content: string, expected?: string | null) => {
    if (expected !== disk) throw new Error('stale write')
    disk = content
  })
  const snapshots: NoteSessionSnapshot[] = []
  const applied: string[] = []
  const session = createNoteSession({
    path: 'daily/2026-09-22.md',
    io: { read, write },
    classify: () => 'exact',
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    applyContent: (content) => {
      applied.push(content)
    },
    saveDebounceMs: 60_000,
  })
  sessions.push(session)
  session.load()
  return {
    session,
    read,
    write,
    snapshots,
    applied,
    setDisk: (content: string) => {
      disk = content
    },
  }
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.discard()
})

it.each(['before', 'after'])(
  'ignores an older reload that finishes %s the new capture reload',
  async (order) => {
    const probe = harness()
    await vi.waitFor(() => expect(probe.snapshots.at(-1)?.status).toBe('ready'))
    const older = Promise.withResolvers<string>()
    const newer = Promise.withResolvers<string>()
    probe.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    probe.session.externalChanged()
    probe.session.externalChanged()
    probe.setDisk(CAPTURED)
    if (order === 'before') older.resolve(ORIGINAL)
    newer.resolve(CAPTURED)
    await vi.waitFor(() => expect(probe.session.content()).toBe(CAPTURED))
    older.resolve(ORIGINAL)
    await older.promise
    expect(probe.applied).toEqual([CAPTURED])
    expect(probe.snapshots.at(-1)).toMatchObject({ dirty: false, conflict: null })
  },
)

it('ignores a late missing-file error after a successful capture reload', async () => {
  const probe = harness()
  await vi.waitFor(() => expect(probe.snapshots.at(-1)?.status).toBe('ready'))
  const older = Promise.withResolvers<string>()
  probe.read.mockReturnValueOnce(older.promise)
  probe.session.externalChanged()
  probe.setDisk(CAPTURED)
  probe.session.externalChanged()
  await vi.waitFor(() => expect(probe.session.content()).toBe(CAPTURED))
  older.reject({ kind: 'notFound', message: 'old read could not find the note' })
  await older.promise.catch(() => {})
  expect(probe.snapshots.at(-1)?.missing).toBe(false)
  probe.session.editorChanged(`${CAPTURED}+ [ ] Next task\n`)
  await probe.session.flush()
  expect(probe.write).toHaveBeenCalledWith(
    'daily/2026-09-22.md',
    `${CAPTURED}+ [ ] Next task\n`,
    CAPTURED,
  )
})

it('invalidates reads that started before a successful save', async () => {
  const probe = harness()
  await vi.waitFor(() => expect(probe.snapshots.at(-1)?.status).toBe('ready'))
  const older = Promise.withResolvers<string>()
  probe.read.mockReturnValueOnce(older.promise)
  probe.session.externalChanged()
  probe.session.editorChanged(CAPTURED)
  await probe.session.flush()
  older.resolve(ORIGINAL)
  await older.promise
  expect(probe.session.content()).toBe(CAPTURED)
  expect(probe.applied).not.toContain(ORIGINAL)
  expect(probe.snapshots.at(-1)).toMatchObject({ dirty: false, conflict: null })
})

it('re-reads an arrival whose read overlapped a completing save', async () => {
  const probe = harness()
  await vi.waitFor(() => expect(probe.snapshots.at(-1)?.status).toBe('ready'))
  const save = Promise.withResolvers<void>()
  probe.write.mockImplementationOnce(async () => await save.promise)
  probe.session.editorChanged(`${ORIGINAL}+ [ ] Typed task\n`)
  const flushed = probe.session.flush()
  await vi.waitFor(() => expect(probe.write).toHaveBeenCalledOnce())
  const arrival = Promise.withResolvers<string>()
  probe.read.mockReturnValueOnce(arrival.promise)
  probe.session.externalChanged()
  probe.setDisk(CAPTURED)
  save.resolve()
  await flushed
  await vi.waitFor(() => expect(probe.session.content()).toBe(CAPTURED))
  arrival.resolve(ORIGINAL)
  await arrival.promise
  expect(probe.session.content()).toBe(CAPTURED)
})

it('does not apply a pending read from a note that was retargeted', async () => {
  const probe = harness()
  await vi.waitFor(() => expect(probe.snapshots.at(-1)?.status).toBe('ready'))
  const older = Promise.withResolvers<string>()
  probe.read.mockReturnValueOnce(older.promise)
  probe.session.externalChanged()
  probe.session.retarget('notes/moved.md')
  older.resolve('# Another file at the old path\n')
  await older.promise
  expect(probe.session.content()).toBe(ORIGINAL)
  expect(probe.applied).toEqual([])
})
