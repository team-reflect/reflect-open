import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { applyIndexChanges, subscribeIndexChanges } from './live'
import type { FileChange } from './file-changes'

afterEach(() => {
  setBridge(null)
})

/** Bridge fake recording invokes; `listen` hands the emitter back to the test. */
function fakeBridge(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  let emit: ((payload: unknown) => void) | null = null
  setBridge({
    invoke,
    listen: async (_event, handler) => {
      emit = handler
      return () => {
        emit = null
      }
    },
  })
  return { emitChanges: (payload: unknown) => emit?.(payload) }
}

describe('applyIndexChanges', () => {
  it('reports a failing change and continues with the rest of the batch', async () => {
    const applied: string[] = []
    fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        if (args.path === 'notes/bad.md') {
          throw { kind: 'io', message: 'unreadable' }
        }
        return '# ok'
      }
      if (command === 'index_apply') {
        applied.push((args.note as { path: string }).path)
      }
      return null
    })

    const failures: Array<{ change: FileChange }> = []
    await applyIndexChanges(
      [
        { path: 'notes/bad.md', kind: 'upsert' },
        { path: 'notes/good.md', kind: 'upsert' },
      ],
      3,
      (_error, change) => failures.push({ change }),
    )

    expect(applied).toEqual(['notes/good.md'])
    expect(failures.map((failure) => failure.change.path)).toEqual(['notes/bad.md'])
  })

  it('routes removes to index_remove at the given generation', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    fakeBridge(async (command, args) => {
      calls.push([command, args])
      return null
    })

    await applyIndexChanges([{ path: 'notes/gone.md', kind: 'remove' }], 9)
    expect(calls).toEqual([['index_remove', { path: 'notes/gone.md', generation: 9 }]])
  })
})

describe('subscribeIndexChanges', () => {
  it('serializes overlapping batches so later events cannot overtake earlier ones', async () => {
    const order: string[] = []
    let releaseFirstRead: () => void = () => {}
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        order.push(`read:${String(args.path)}`)
        if (args.path === 'notes/slow.md') {
          await new Promise<void>((resolve) => {
            releaseFirstRead = resolve
          })
        }
        return '# content'
      }
      if (command === 'index_apply') {
        order.push(`apply:${(args.note as { path: string }).path}`)
      }
      return null
    })

    await subscribeIndexChanges(1)
    emitChanges([{ path: 'notes/slow.md', kind: 'upsert' }])
    emitChanges([{ path: 'notes/fast.md', kind: 'upsert' }])
    await vi.waitFor(() => {
      expect(order).toContain('read:notes/slow.md')
    })
    // The second batch must not start while the first is still applying.
    expect(order).not.toContain('read:notes/fast.md')

    releaseFirstRead()
    await vi.waitFor(() => {
      expect(order).toContain('apply:notes/fast.md')
    })
    expect(order).toEqual([
      'read:notes/slow.md',
      'apply:notes/slow.md',
      'read:notes/fast.md',
      'apply:notes/fast.md',
    ])
  })

  it('fires onApplied only after the batch has been written to the index', async () => {
    const order: string[] = []
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        return '# content'
      }
      if (command === 'index_apply') {
        order.push(`apply:${(args.note as { path: string }).path}`)
      }
      return null
    })

    await subscribeIndexChanges(1, (changes) => {
      order.push(`applied:${changes.map((change) => change.path).join(',')}`)
    })
    emitChanges([{ path: 'notes/a.md', kind: 'upsert' }])
    await vi.waitFor(() => {
      expect(order).toContain('applied:notes/a.md')
    })
    expect(order).toEqual(['apply:notes/a.md', 'applied:notes/a.md'])
  })

  it('stamps the indexed row with the modifiedMs carried by the event', async () => {
    const mtimes: number[] = []
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        return '# content'
      }
      if (command === 'index_apply') {
        mtimes.push((args.note as { mtime: number }).mtime)
      }
      return null
    })

    await subscribeIndexChanges(1)
    emitChanges([{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1234 }])
    await vi.waitFor(() => {
      expect(mtimes).toEqual([1234])
    })
  })

  it('drops malformed payloads instead of applying them', async () => {
    const calls: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { emitChanges } = fakeBridge(async (command) => {
        calls.push(command)
        return null
      })
      await subscribeIndexChanges(1)
      emitChanges({ not: 'an array' })
      emitChanges([{ path: 1, kind: 'upsert' }])
      await Promise.resolve()
      expect(calls).toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('applyIndexChanges move healing (Plan 17)', () => {
  const OLD = 'notes/01arz3ndektsv4rrffq69g5fav.md'
  const NEW = 'notes/meeting-notes.md'
  const CONTENT = '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Meeting Notes\n'

  /** Bridge where OLD is indexed (with the id) and NEW exists on disk. */
  function renameBridge(options?: { rowId?: string | null }) {
    const calls: Array<[string, Record<string, unknown>]> = []
    fakeBridge(async (command, args) => {
      calls.push([command, args])
      if (command === 'note_read') {
        if (args.path === NEW) {
          return CONTENT
        }
        throw { kind: 'notFound', message: 'missing' }
      }
      if (command === 'db_query') {
        const params = (args.params as unknown[]) ?? []
        if (params.includes(OLD)) {
          return [{ path: OLD, id: options?.rowId === undefined ? '01abcdefghjkmnpqrstvwxyz00' : options.rowId }]
        }
        return [] // the upsert path is not indexed
      }
      return null
    })
    return calls
  }

  it('heals a same-batch external rename: rows move, nothing is removed', async () => {
    const calls = renameBridge()

    await applyIndexChanges(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert', modifiedMs: 42 },
      ],
      7,
    )

    const commands = calls.map(([command]) => command)
    expect(commands).toContain('index_move')
    expect(commands).not.toContain('index_remove')
    const move = calls.find(([command]) => command === 'index_move')
    expect(move?.[1]).toEqual({ from: OLD, to: NEW, generation: 7 })
    const apply = calls.find(([command]) => command === 'index_apply')
    expect((apply?.[1].note as { path: string; mtime: number }).path).toBe(NEW)
    expect((apply?.[1].note as { path: string; mtime: number }).mtime).toBe(42)
  })

  it('announces the heal via onMoved so the app can follow', async () => {
    renameBridge()
    const moves: Array<[string, string]> = []

    await applyIndexChanges(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert' },
      ],
      7,
      undefined,
      (from, to) => moves.push([from, to]),
    )

    expect(moves).toEqual([[OLD, NEW]])
  })

  it('falls back to delete+create when the ids do not match', async () => {
    const calls = renameBridge({ rowId: 'completely-different-id' })

    await applyIndexChanges(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert' },
      ],
      7,
    )

    const commands = calls.map(([command]) => command)
    expect(commands).not.toContain('index_move')
    expect(commands).toContain('index_remove')
    expect(commands).toContain('index_apply')
  })

  it("Reflect's own move echo never pairs: the removed side has no row left", async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    fakeBridge(async (command, args) => {
      calls.push([command, args])
      if (command === 'note_read') {
        return CONTENT
      }
      if (command === 'db_query') {
        return [] // neither path has a row under the old key (already moved)
      }
      return null
    })

    await applyIndexChanges(
      [
        { path: OLD, kind: 'remove' },
        { path: NEW, kind: 'upsert' },
      ],
      7,
    )

    const commands = calls.map(([command]) => command)
    expect(commands).not.toContain('index_move')
    expect(commands).toContain('index_remove') // no-op against a moved row
    expect(commands).toContain('index_apply') // idempotent re-apply
  })
})
