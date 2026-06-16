import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { emitFileChanges, subscribeFileChanges, type FileChange } from './file-changes'

afterEach(() => {
  setBridge(null)
})

/** Bridge fake; `listen` hands the bridge-side emitter back to the test. */
function fakeBridge() {
  let emit: ((payload: unknown) => void) | null = null
  setBridge({
    invoke: async () => null,
    listen: async (_event, handler) => {
      emit = handler
      return () => {
        emit = null
      }
    },
  })
  return { emitFromBridge: (payload: unknown) => emit?.(payload) }
}

describe('subscribeFileChanges', () => {
  it('delivers locally emitted batches (sync merges) like watcher events', async () => {
    fakeBridge()
    const received: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => received.push(changes))

    const changes: FileChange[] = [
      { path: 'notes/from-b.md', kind: 'upsert', modifiedMs: 123 },
      { path: 'notes/gone.md', kind: 'remove' },
    ]
    emitFileChanges(changes)

    expect(received).toEqual([changes])
    unlisten()
  })

  it('stops local delivery after unlisten', async () => {
    fakeBridge()
    const received: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => received.push(changes))
    unlisten()

    emitFileChanges([{ path: 'notes/a.md', kind: 'upsert' }])

    expect(received).toEqual([])
  })

  it('delivers both bridge and local batches to the same subscriber', async () => {
    const { emitFromBridge } = fakeBridge()
    const received: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => received.push(changes))

    emitFromBridge([{ path: 'notes/watched.md', kind: 'upsert' }])
    emitFileChanges([{ path: 'notes/merged.md', kind: 'upsert' }])

    expect(received.map((batch) => batch[0]!.path)).toEqual([
      'notes/watched.md',
      'notes/merged.md',
    ])
    unlisten()
  })
})
