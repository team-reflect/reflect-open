import { describe, expect, it, vi } from 'vitest'
import type { NoteRow, PinnedNote } from '../indexing/index-query-service.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import {
  applyNoteRowOverlay,
  applyNoteRowOverlays,
  applyPinnedNoteOverlays,
  createNoteRowService,
} from './note-row-service.ts'

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

const URL = 'https://gist.github.com/alex/g1'
const GEN = 1

/**
 * A row service over a test graph session with graph generation {@link GEN} open.
 */
function createRows() {
  const graph = createTestGraphSessionService({ graph: { generation: GEN } })
  return { noteRows: createNoteRowService({ graphSession: graph }), graph }
}

describe('applyNoteRowOverlay', () => {
  it('merges overlay fields over the row', () => {
    expect(
      applyNoteRowOverlay(noteRow({ gistStale: true }), {
        gistUrl: URL,
        gistStale: false,
      }),
    ).toMatchObject({
      gistUrl: URL,
      gistStale: false,
    })
  })

  it('passes a null row through: the overlay only sharpens an existing row', () => {
    expect(applyNoteRowOverlay(null, { gistUrl: URL })).toBeNull()
  })

  it('returns the same row reference when there is no overlay', () => {
    const row = noteRow({ gistUrl: 'kept' })
    expect(applyNoteRowOverlay(row, null)).toBe(row)
  })

  it('merges only the fields a note row has', () => {
    expect(
      applyNoteRowOverlay(noteRow(), { isPrivate: true, isPinned: true, trashed: true }),
    ).toEqual(noteRow({ isPrivate: true }))
  })
})

describe('applyNoteRowOverlays', () => {
  const rows = [
    { path: 'notes/a.md', isPinned: false },
    { path: 'notes/b.md', isPinned: false },
    { path: 'notes/c.md', isPinned: true },
  ]

  it('drops trashed rows and merges the fields each row has', () => {
    const overlays = new Map([
      ['notes/a.md', { isPinned: true, pinnedOrder: 1024, isPrivate: true }],
      ['notes/b.md', { trashed: true }],
    ])
    expect(applyNoteRowOverlays(rows, overlays)).toEqual([
      { path: 'notes/a.md', isPinned: true },
      { path: 'notes/c.md', isPinned: true },
    ])
  })

  it('returns the same array when nothing changes', () => {
    expect(applyNoteRowOverlays(rows, new Map())).toBe(rows)
    expect(applyNoteRowOverlays(rows, new Map([['notes/c.md', { isPinned: true }]]))).toBe(rows)
  })
})

describe('applyPinnedNoteOverlays', () => {
  function pinned(path: string, pinnedOrder: number | null): PinnedNote {
    return { path, title: path, dailyDate: null, pinnedOrder }
  }
  const preview = (path: string): PinnedNote => pinned(`preview:${path}`, null)
  const shelf = [pinned('a', 1024), pinned('b', 2048), pinned('c', null), pinned('d', null)]

  it('removes unpinned and trashed notes and moves reordered ones', () => {
    const overlays = new Map([
      ['a', { pinnedOrder: 3072 }],
      ['b', { isPinned: false }],
      ['c', { trashed: true }],
    ])
    expect(applyPinnedNoteOverlays(shelf, overlays, preview)).toEqual([
      pinned('a', 3072),
      pinned('d', null),
    ])
  })

  it('adds a new pin where its order sorts, and a bare pin last', () => {
    const overlays = new Map([
      ['x', { isPinned: true, pinnedOrder: 1536 }],
      ['y', { isPinned: true, pinnedOrder: null }],
    ])
    expect(
      applyPinnedNoteOverlays(shelf, overlays, preview).map((note) => [
        note.path,
        note.pinnedOrder,
      ]),
    ).toEqual([
      ['a', 1024],
      ['preview:x', 1536],
      ['b', 2048],
      ['c', null],
      ['d', null],
      ['preview:y', null],
    ])
  })

  it('returns the same shelf when nothing changes', () => {
    expect(applyPinnedNoteOverlays(shelf, new Map([['a', { isPinned: true }]]), preview)).toBe(
      shelf,
    )
  })
})

describe('setOverlay', () => {
  it('ignores an empty or all-undefined patch (no non-reconcilable entry)', () => {
    const { noteRows } = createRows()
    const listener = vi.fn()
    noteRows.subscribe(listener)
    noteRows.setOverlay('notes/a.md', GEN, {})
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: undefined })
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })

  it('scopes the overlay to the writing generation', () => {
    const { noteRows, graph } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    expect(noteRows.get().get('notes/a.md')?.gistUrl).toBe(URL)
    // A reader on a different graph generation never sees it.
    graph.setGraph({ generation: GEN + 1 })
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
    graph.setGraph(null)
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })

  it('merges patches of the same generation', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    noteRows.setOverlay('notes/a.md', GEN, { gistStale: false })
    expect(noteRows.get().get('notes/a.md')).toEqual({ gistUrl: URL, gistStale: false })
  })

  it('lets a newer generation replace an older overlay', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: 'old' })
    noteRows.setOverlay('notes/a.md', GEN + 1, { gistUrl: 'new' })
    expect(noteRows.getOverlaysOn(GEN + 1).get('notes/a.md')?.gistUrl).toBe('new')
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })

  it('ignores an older generation late write, keeping the newer overlay', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN + 1, { gistUrl: 'new' })
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: 'stale' }) // older graph, resolved late
    expect(noteRows.getOverlaysOn(GEN + 1).get('notes/a.md')?.gistUrl).toBe('new')
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })

  it('drops the pin order on an unpin and the trash mark on any other patch', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true, pinnedOrder: 1024 })
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: false })
    expect(noteRows.get().get('notes/a.md')).toEqual({ isPinned: false })

    noteRows.setOverlay('notes/a.md', GEN, { trashed: true })
    noteRows.setOverlay('notes/a.md', GEN, { isPrivate: true })
    expect(noteRows.get().get('notes/a.md')).toEqual({ isPinned: false, isPrivate: true })
  })

  it('keeps the overlays of two services apart', () => {
    const first = createRows().noteRows
    const second = createRows().noteRows
    first.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    expect(second.get().get('notes/a.md')).toBeUndefined()
  })
})

describe('reconcile', () => {
  it('holds the overlay while the index still lags, retires it once they agree', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })

    noteRows.reconcile('notes/a.md', noteRow({ gistUrl: null }))
    expect(noteRows.get().get('notes/a.md')?.gistUrl).toBe(URL) // index hasn't caught up

    noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL }))
    expect(noteRows.get().get('notes/a.md')).toBeUndefined() // index agrees, retired
  })

  it('retires overlay fields independently as the index catches up', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL, gistStale: false })

    noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL, gistStale: true }))
    expect(noteRows.get().get('notes/a.md')).toEqual({ gistStale: false })

    noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL, gistStale: false }))
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })

  it('holds the overlay against a null row (nothing to compare yet)', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    noteRows.reconcile('notes/a.md', null)
    expect(noteRows.get().get('notes/a.md')?.gistUrl).toBe(URL)
  })

  it('holds an overlay whose generation does not match the reconciling read', () => {
    const { noteRows, graph } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    // A reconcile on a *different* generation can't retire this overlay, even
    // when the row's value matches, so a stale-graph read never drops it.
    graph.setGraph({ generation: GEN + 1 })
    noteRows.reconcile('notes/a.md', noteRow({ gistUrl: URL }))
    expect(noteRows.getOverlaysOn(GEN).get('notes/a.md')?.gistUrl).toBe(URL)
  })
})

describe('reconcile (pin, private, trash)', () => {
  it('retires pin fields only from a read that carries them', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true, pinnedOrder: 1024, isPrivate: true })

    noteRows.reconcile('notes/a.md', noteRow({ isPrivate: true }))
    expect(noteRows.get().get('notes/a.md')).toEqual({ isPinned: true, pinnedOrder: 1024 })

    noteRows.reconcile('notes/a.md', { isPinned: true, pinnedOrder: 1024 })
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })

  it('retires a trashed note once the index has no row for it', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { trashed: true })

    noteRows.reconcile('notes/a.md', noteRow())
    expect(noteRows.get().get('notes/a.md')).toEqual({ trashed: true })

    noteRows.reconcile('notes/a.md', null)
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })
})

describe('reconcileRows', () => {
  it('reconciles each listed row and notifies once', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true })
    noteRows.setOverlay('notes/b.md', GEN, { isPinned: false })
    const listener = vi.fn()
    noteRows.subscribe(listener)

    noteRows.reconcileRows([
      { path: 'notes/a.md', isPinned: true },
      { path: 'notes/b.md', isPinned: false },
    ])

    expect(noteRows.get().size).toBe(0)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('retires a trashed note missing from a complete list only', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { trashed: true })

    noteRows.reconcileRows([{ path: 'notes/b.md' }])
    expect(noteRows.get().get('notes/a.md')).toEqual({ trashed: true })
    noteRows.reconcileRows([{ path: 'notes/a.md' }], { complete: true })
    expect(noteRows.get().get('notes/a.md')).toEqual({ trashed: true })

    noteRows.reconcileRows([{ path: 'notes/b.md' }], { complete: true })
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })
})

describe('dropOverlay', () => {
  it("drops only the fields that still hold the failed action's values", () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { pinnedOrder: 2048, gistUrl: URL })

    noteRows.dropOverlay('notes/a.md', GEN, { pinnedOrder: 1024 })
    expect(noteRows.get().get('notes/a.md')).toEqual({ pinnedOrder: 2048, gistUrl: URL })

    noteRows.dropOverlay('notes/a.md', GEN, { pinnedOrder: 2048 })
    expect(noteRows.get().get('notes/a.md')).toEqual({ gistUrl: URL })

    noteRows.dropOverlay('notes/a.md', GEN, { gistUrl: URL })
    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
  })
})

describe('get', () => {
  it("returns the open graph's overlays as a snapshot that changes only with them", () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true })
    noteRows.setOverlay('notes/b.md', GEN + 1, { isPinned: true })

    const snapshot = noteRows.get()
    expect([...snapshot]).toEqual([['notes/a.md', { isPinned: true }]])
    expect(noteRows.get()).toBe(snapshot)
    expect(noteRows.getOverlaysOn(GEN)).toBe(snapshot)
    expect([...noteRows.getOverlaysOn(GEN + 1)]).toEqual([['notes/b.md', { isPinned: true }]])
    expect(noteRows.get()).toBe(snapshot)

    noteRows.setOverlay('notes/a.md', GEN, { isPrivate: true })
    expect(noteRows.get()).not.toBe(snapshot)
  })

  it('keeps the snapshot and does not notify on a write that changes no overlay on the open graph', () => {
    const { noteRows, graph } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true })
    const snapshot = noteRows.get()
    const listener = vi.fn()
    noteRows.subscribe(listener)

    noteRows.setOverlay('notes/b.md', GEN + 1, { isPinned: true })
    noteRows.setOverlay('notes/a.md', GEN - 1, { isPrivate: true })
    noteRows.dropOverlay('notes/a.md', GEN, { isPrivate: true })
    noteRows.reconcile('notes/a.md', { isPrivate: false })
    graph.setGraph({ generation: GEN })

    expect(noteRows.get()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const { noteRows } = createRows()
    const listener = vi.fn()
    const unlisten = noteRows.subscribe(listener)

    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true })
    expect(listener).toHaveBeenCalledOnce()
    unlisten()
    noteRows.setOverlay('notes/b.md', GEN, { isPinned: true })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('reads nothing while no graph is open and notifies when the graph changes', () => {
    const { noteRows, graph } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { isPinned: true })
    const listener = vi.fn()
    noteRows.subscribe(listener)

    graph.setGraph(null)
    expect(listener).toHaveBeenCalled()
    expect(noteRows.get().size).toBe(0)
    noteRows.reconcileRows([], { complete: true })
    expect(noteRows.getOverlaysOn(GEN).size).toBe(1)
  })
})

describe('reset', () => {
  it('drops every overlay (e.g. on a graph switch) and notifies once', () => {
    const { noteRows } = createRows()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    const listener = vi.fn()
    const unlisten = noteRows.subscribe(listener)

    noteRows.reset()
    noteRows.reset()

    expect(noteRows.get().get('notes/a.md')).toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()
    unlisten()
    noteRows.setOverlay('notes/a.md', GEN, { gistUrl: URL })
    expect(listener).toHaveBeenCalledOnce()
  })
})
