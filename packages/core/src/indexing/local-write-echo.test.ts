import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { deleteNote, writeNote } from '../graph/commands'
import { subscribeFileChanges, type FileChange } from './file-changes'
import { setLocalWriteEcho } from './local-write-echo'

afterEach(() => {
  setLocalWriteEcho(false)
  setBridge(null)
})

/** Bridge fake: every invoke succeeds with `null` (the void contract). */
function fakeBridge() {
  setBridge({
    invoke: async () => null,
    listen: async () => () => {},
  })
}

describe('local write echo (Plan 19, decision 5)', () => {
  it('emits an upsert to file-change subscribers after a note write', async () => {
    fakeBridge()
    setLocalWriteEcho(true)
    const seen: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => {
      seen.push(changes)
    })

    await writeNote('daily/2026-06-12.md', 'hello', 1)

    expect(seen).toHaveLength(1)
    expect(seen[0]![0]).toMatchObject({ path: 'daily/2026-06-12.md', kind: 'upsert' })
    expect(seen[0]![0]!.modifiedMs).toBeTypeOf('number')
    unlisten()
  })

  it('emits a remove after a delete', async () => {
    fakeBridge()
    setLocalWriteEcho(true)
    const seen: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => {
      seen.push(changes)
    })

    await deleteNote('notes/gone.md', 1)

    expect(seen).toEqual([[{ path: 'notes/gone.md', kind: 'remove' }]])
    unlisten()
  })

  it('stamps the echo with the on-disk mtime the write returned', async () => {
    // The reconcile's read-free skip compares the stored row's mtime against
    // the file listing — only the write's own on-disk stamp can ever match.
    setBridge({
      invoke: async (command) => (command === 'note_write' ? 1_234 : null),
      listen: async () => () => {},
    })
    setLocalWriteEcho(true)
    const seen: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => {
      seen.push(changes)
    })

    await writeNote('notes/a.md', 'hello', 1)

    expect(seen).toEqual([[{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1_234 }]])
    unlisten()
  })

  it('stays silent when disabled (the desktop default — the watcher covers it)', async () => {
    fakeBridge()
    const handler = vi.fn()
    const unlisten = await subscribeFileChanges(handler)

    await writeNote('daily/2026-06-12.md', 'hello', 1)

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })

  it('does not emit when the write itself fails', async () => {
    setBridge({
      invoke: async () => {
        throw new Error('disk full')
      },
      listen: async () => () => {},
    })
    setLocalWriteEcho(true)
    const handler = vi.fn()
    const unlisten = await subscribeFileChanges(handler)

    await expect(writeNote('daily/2026-06-12.md', 'hello', 1)).rejects.toThrow()

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })
})
