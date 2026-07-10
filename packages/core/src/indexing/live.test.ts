import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import type { FileChange } from './file-changes'
import { subscribeIndexApplied } from './index-applied'
import { applyIndexChanges, subscribeIndexChanges } from './live'

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
        if (args['path'] === 'notes/bad.md') {
          throw { kind: 'io', message: 'unreadable' }
        }
        return '# ok'
      }
      if (command === 'index_apply_batch') {
        applied.push(...(args['notes'] as Array<{ path: string }>).map((note) => note.path))
      }
      if (command === 'db_query') {
        return []
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

  it('applies an upsert(x) … remove(x) sequence in order — the remove wins', async () => {
    const order: string[] = []
    fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        return '# recreated then deleted'
      }
      if (command === 'index_apply_batch') {
        order.push(...(args['notes'] as Array<{ path: string }>).map((note) => `apply:${note.path}`))
      }
      if (command === 'index_remove') {
        order.push(`remove:${String(args['path'])}`)
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })

    await applyIndexChanges(
      [
        { path: 'notes/x.md', kind: 'upsert', modifiedMs: 42 },
        { path: 'notes/x.md', kind: 'remove' },
      ],
      9,
    )

    // The batched upsert must flush before the remove — a remove overtaken by
    // its own earlier upsert would resurrect a deleted note as a ghost row.
    expect(order).toEqual(['apply:notes/x.md', 'remove:notes/x.md'])
  })

  it('skips non-note paths — the watcher also reports audio-memo recordings', async () => {
    const invoked: string[] = []
    fakeBridge(async (command) => {
      invoked.push(command)
      return command === 'note_read' ? '# ok' : null
    })

    await applyIndexChanges(
      [
        { path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' },
        { path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'remove' },
      ],
      3,
    )

    expect(invoked).toEqual([])
  })
})

describe('subscribeIndexChanges', () => {
  it('serializes overlapping batches so later events cannot overtake earlier ones', async () => {
    const order: string[] = []
    let releaseFirstRead: () => void = () => {}
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        order.push(`read:${String(args['path'])}`)
        if (args['path'] === 'notes/slow.md') {
          await new Promise<void>((resolve) => {
            releaseFirstRead = resolve
          })
        }
        return '# content'
      }
      if (command === 'index_apply_batch') {
        order.push(...(args['notes'] as Array<{ path: string }>).map((note) => `apply:${note.path}`))
      }
      if (command === 'db_query') {
        return []
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

  it('drops queued live writes when the lifecycle suspends and leaves replay to reconcile', async () => {
    const order: string[] = []
    let canApply = true
    let releaseRead: () => void = () => {}
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        order.push(`read:${String(args['path'])}`)
        await new Promise<void>((resolve) => {
          releaseRead = resolve
        })
        order.push(`read-finished:${String(args['path'])}`)
      }
      if (command === 'index_apply_batch') {
        order.push('apply')
      }
      if (command === 'db_query') {
        return []
      }
      return command === 'note_read' ? '# content' : null
    })

    await subscribeIndexChanges(1, undefined, undefined, () => canApply)
    emitChanges([{ path: 'notes/started-visible.md', kind: 'upsert' }])
    emitChanges([{ path: 'notes/queued.md', kind: 'upsert' }])
    await vi.waitFor(() => expect(order).toContain('read:notes/started-visible.md'))

    canApply = false
    releaseRead()
    await vi.waitFor(() => expect(order).toContain('read-finished:notes/started-visible.md'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The first batch had begun reading while visible, but did not start its
    // SQLite write after suspension. The second never began at all; the
    // foreground full reconcile is the durable replay path for both.
    expect(order).not.toContain('apply')
    expect(order).not.toContain('read:notes/queued.md')
  })

  it('fires onApplied only after the batch has been written to the index', async () => {
    const order: string[] = []
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        return '# content'
      }
      if (command === 'index_apply_batch') {
        order.push(...(args['notes'] as Array<{ path: string }>).map((note) => `apply:${note.path}`))
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })

    await subscribeIndexChanges(1, (changes) => {
      order.push(`applied:${changes.map((change) => change.path).join(',')}`)
    })
    // A recordings-only batch never reaches the queue or onApplied; a mixed
    // batch applies (and reports) only its notes.
    emitChanges([{ path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' }])
    emitChanges([
      { path: 'notes/a.md', kind: 'upsert' },
      { path: 'audio-memos/audio-memo-2026-06-12-091500-000.m4a', kind: 'upsert' },
    ])
    await vi.waitFor(() => {
      expect(order).toContain('applied:notes/a.md')
    })
    expect(order).toEqual(['apply:notes/a.md', 'applied:notes/a.md'])
  })

  it('emits index-applied to subscribers after the batch is written — notes settle first', async () => {
    const order: string[] = []
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        return '# content'
      }
      if (command === 'index_apply_batch') {
        order.push(...(args['notes'] as Array<{ path: string }>).map((note) => `apply:${note.path}`))
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })
    const unsubscribe = subscribeIndexApplied((changes) => {
      order.push(`applied:${changes.map((change) => change.path).join(',')}`)
    })

    await subscribeIndexChanges(1)
    // A note batch, then an asset-only batch: the asset emit must follow the
    // note's apply, so a gate reading the index off the asset emit sees the note.
    emitChanges([{ path: 'notes/a.md', kind: 'upsert' }])
    emitChanges([{ path: 'assets/x.png', kind: 'upsert' }])
    await vi.waitFor(() => {
      expect(order).toContain('applied:assets/x.png')
    })

    expect(order).toEqual(['apply:notes/a.md', 'applied:notes/a.md', 'applied:assets/x.png'])
    unsubscribe()
  })

  it('does not emit index-applied for a recordings-only batch', async () => {
    const seen: string[] = []
    const { emitChanges } = fakeBridge(async () => null)
    const unsubscribe = subscribeIndexApplied((changes) => {
      seen.push(changes.map((change) => change.path).join(','))
    })

    await subscribeIndexChanges(1)
    emitChanges([{ path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' }])
    emitChanges([{ path: 'assets/y.png', kind: 'upsert' }]) // something to wait on
    await vi.waitFor(() => {
      expect(seen).toContain('assets/y.png')
    })

    expect(seen).toEqual(['assets/y.png']) // the recordings batch emitted nothing
    unsubscribe()
  })

  it('stamps the indexed row with the modifiedMs carried by the event', async () => {
    const mtimes: number[] = []
    const { emitChanges } = fakeBridge(async (command, args) => {
      if (command === 'note_read') {
        return '# content'
      }
      if (command === 'index_apply_batch') {
        mtimes.push(...(args['notes'] as Array<{ mtime: number }>).map((note) => note.mtime))
      }
      if (command === 'db_query') {
        return []
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
        if (args['path'] === NEW) {
          return CONTENT
        }
        throw { kind: 'notFound', message: 'missing' }
      }
      if (command === 'db_query') {
        const params = (args['params'] as unknown[]) ?? []
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
    expect(apply).toBeDefined()
    if (apply === undefined) {
      throw new Error('Expected rename heal to apply the renamed note')
    }
    const note = apply[1]['note'] as { path: string; mtime: number }
    expect(note.path).toBe(NEW)
    expect(note.mtime).toBe(42)
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
    expect(commands).toContain('index_apply_batch')
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
    expect(commands).toContain('index_apply_batch') // idempotent re-apply
  })
})
