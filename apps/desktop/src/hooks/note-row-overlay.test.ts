import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NoteRow } from '@reflect/core'
import {
  applyNoteRowOverlay,
  getNoteRowOverlay,
  reconcileNoteRowOverlay,
  resetNoteRowOverlays,
  setNoteRowOverlay,
  useNoteRowOverlay,
} from './note-row-overlay'

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

const URL = 'https://gist.github.com/alex/g1'
const GEN = 1

beforeEach(() => {
  resetNoteRowOverlays()
})
afterEach(() => {
  resetNoteRowOverlays()
})

describe('applyNoteRowOverlay', () => {
  it('merges overlay fields over the row', () => {
    expect(applyNoteRowOverlay(noteRow({ gistStale: true }), { gistUrl: URL, gistStale: false })).toMatchObject({
      gistUrl: URL,
      gistStale: false,
    })
  })

  it('passes a null row through — the overlay only sharpens an existing row', () => {
    expect(applyNoteRowOverlay(null, { gistUrl: URL })).toBeNull()
  })

  it('returns the same row reference when there is no overlay', () => {
    const row = noteRow({ gistUrl: 'kept' })
    expect(applyNoteRowOverlay(row, null)).toBe(row)
  })
})

describe('setNoteRowOverlay', () => {
  it('ignores an empty or all-undefined patch (no non-reconcilable entry)', () => {
    setNoteRowOverlay('notes/a.md', GEN, {})
    setNoteRowOverlay('notes/a.md', GEN, { gistUrl: undefined })
    expect(getNoteRowOverlay('notes/a.md', GEN)).toBeNull()
  })

  it('scopes the overlay to the writing generation', () => {
    setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL })
    expect(getNoteRowOverlay('notes/a.md', GEN)?.gistUrl).toBe(URL)
    // A reader on a different graph generation never sees it.
    expect(getNoteRowOverlay('notes/a.md', GEN + 1)).toBeNull()
    expect(getNoteRowOverlay('notes/a.md', undefined)).toBeNull()
  })

  it('lets a newer generation replace an older overlay', () => {
    setNoteRowOverlay('notes/a.md', GEN, { gistUrl: 'old' })
    setNoteRowOverlay('notes/a.md', GEN + 1, { gistUrl: 'new' })
    expect(getNoteRowOverlay('notes/a.md', GEN + 1)?.gistUrl).toBe('new')
    expect(getNoteRowOverlay('notes/a.md', GEN)).toBeNull()
  })

  it('ignores an older generation late write, keeping the newer overlay', () => {
    setNoteRowOverlay('notes/a.md', GEN + 1, { gistUrl: 'new' })
    setNoteRowOverlay('notes/a.md', GEN, { gistUrl: 'stale' }) // older graph, resolved late
    expect(getNoteRowOverlay('notes/a.md', GEN + 1)?.gistUrl).toBe('new')
    expect(getNoteRowOverlay('notes/a.md', GEN)).toBeNull()
  })
})

describe('useNoteRowOverlay', () => {
  it('reflects a set overlay and scopes it to the path', () => {
    const { result } = renderHook(() => useNoteRowOverlay('notes/a.md', GEN))
    const other = renderHook(() => useNoteRowOverlay('notes/b.md', GEN))
    expect(result.current).toBeNull()

    act(() => setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL }))
    expect(result.current?.gistUrl).toBe(URL)
    expect(other.result.current).toBeNull()
  })

  it('retires overlay fields independently as the index catches up', () => {
    const { result } = renderHook(() => useNoteRowOverlay('notes/a.md', GEN))
    act(() => setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL, gistStale: false }))

    act(() => reconcileNoteRowOverlay('notes/a.md', GEN, noteRow({ gistUrl: URL, gistStale: true })))
    expect(result.current).toEqual({ gistStale: false })

    act(() => reconcileNoteRowOverlay('notes/a.md', GEN, noteRow({ gistUrl: URL, gistStale: false })))
    expect(result.current).toBeNull()
  })
})

describe('reconcileNoteRowOverlay', () => {
  it('holds the overlay while the index still lags, retires it once they agree', () => {
    const { result } = renderHook(() => useNoteRowOverlay('notes/a.md', GEN))
    act(() => setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL }))

    act(() => reconcileNoteRowOverlay('notes/a.md', GEN, noteRow({ gistUrl: null })))
    expect(result.current?.gistUrl).toBe(URL) // index hasn't caught up

    act(() => reconcileNoteRowOverlay('notes/a.md', GEN, noteRow({ gistUrl: URL })))
    expect(result.current).toBeNull() // index agrees → retired
  })

  it('holds the overlay against a null row (nothing to compare yet)', () => {
    const { result } = renderHook(() => useNoteRowOverlay('notes/a.md', GEN))
    act(() => setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL }))
    act(() => reconcileNoteRowOverlay('notes/a.md', GEN, null))
    expect(result.current?.gistUrl).toBe(URL)
  })

  it('holds an overlay whose generation does not match the reconciling read', () => {
    setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL })
    // A reconcile on a *different* generation can't retire this overlay — even
    // when the row's value matches — so a stale-graph read never drops it.
    reconcileNoteRowOverlay('notes/a.md', GEN + 1, noteRow({ gistUrl: URL }))
    expect(getNoteRowOverlay('notes/a.md', GEN)?.gistUrl).toBe(URL)
  })
})

describe('resetNoteRowOverlays', () => {
  it('drops every overlay (e.g. on a graph switch)', () => {
    const { result } = renderHook(() => useNoteRowOverlay('notes/a.md', GEN))
    act(() => setNoteRowOverlay('notes/a.md', GEN, { gistUrl: URL }))
    expect(result.current?.gistUrl).toBe(URL)

    act(() => resetNoteRowOverlays())
    expect(result.current).toBeNull()
  })
})
