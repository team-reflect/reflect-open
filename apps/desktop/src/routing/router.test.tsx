import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { emitNoteMoved } from '@/lib/note-moves'
import type { Route } from './route'
import { RouterProvider, useRouter } from './router'

function routerHook(initialRoute?: Route) {
  return renderHook(() => useRouter(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <RouterProvider initialRoute={initialRoute}>{children}</RouterProvider>
    ),
  })
}

describe('router', () => {
  it('starts on today with no history', () => {
    const { result } = routerHook()
    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.canBack).toBe(false)
    expect(result.current.canForward).toBe(false)
  })

  it('navigate pushes; back and forward traverse the stack', () => {
    const { result } = routerHook()
    act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })

    act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(result.current.canForward).toBe(true)

    act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.canForward).toBe(false)
  })

  it('navigating from a back position truncates the forward branch', () => {
    const { result } = routerHook()
    act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    act(() => result.current.navigate({ kind: 'daily', date: '2026-06-07' }))
    act(() => result.current.back())
    act(() => result.current.navigate({ kind: 'search', query: 'x' }))
    expect(result.current.canForward).toBe(false)
    act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('re-navigating to the current route is a no-op (no stack growth)', () => {
    const { result } = routerHook()
    act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.canBack).toBe(false)
  })

  it('back/forward at the edges are no-ops', () => {
    const { result } = routerHook()
    act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'today' })
    act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'today' })
  })

  it('restores a saved scroll offset on back/forward, per entry', () => {
    const { result } = routerHook()
    act(() => result.current.saveScrollState(120)) // scrolling on today
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.savedScroll()).toBeNull() // fresh entry: no offset yet

    act(() => result.current.saveScrollState(40))
    act(() => result.current.back())
    expect(result.current.savedScroll()).toBe(120) // today's offset restored

    act(() => result.current.forward())
    expect(result.current.savedScroll()).toBe(40) // the note's own offset
  })

  it('re-navigating to the current route clears its saved scroll (re-anchor intent)', () => {
    const { result } = routerHook()
    const seqBefore = result.current.arrivalSeq
    act(() => result.current.saveScrollState(500)) // user scrolled away on today
    act(() => result.current.navigate({ kind: 'today' })) // ⌘D while on today
    expect(result.current.savedScroll()).toBeNull() // re-anchor, don't restore
    expect(result.current.arrivalSeq).toBe(seqBefore + 1) // views are notified
  })

  it('entryId is stable per entry and changes across back/forward', () => {
    const { result } = routerHook()
    const todayId = result.current.entryId
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    const noteId = result.current.entryId
    expect(noteId).not.toBe(todayId)
    act(() => result.current.back())
    expect(result.current.entryId).toBe(todayId)
    act(() => result.current.forward())
    expect(result.current.entryId).toBe(noteId)
  })

  it('normalizes a malformed daily date to the today route on navigate', () => {
    const { result } = routerHook()
    // 2026-02-31 is well-formed but impossible — dailyPath would throw on it.
    act(() => result.current.navigate({ kind: 'daily', date: '2026-02-31' }))
    expect(result.current.route).toEqual({ kind: 'today' })
    // Normalization happens before the no-op check: re-navigating doesn't push.
    expect(result.current.canBack).toBe(false)
  })

  it('normalizes a malformed daily initial route to today', () => {
    const { result } = routerHook({ kind: 'daily', date: 'not-a-date' })
    expect(result.current.route).toEqual({ kind: 'today' })
  })

  it('keeps a real daily date intact', () => {
    const { result } = routerHook()
    act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('drops scroll offsets for a truncated forward branch', () => {
    const { result } = routerHook()
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    act(() => result.current.saveScrollState(99))
    act(() => result.current.back())
    // Navigating from a back position truncates the branch holding notes/a.md.
    act(() => result.current.navigate({ kind: 'search', query: 'x' }))
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.savedScroll()).toBeNull() // a new entry, not the old one
  })

  describe('note moves (Plan 17)', () => {
    it('rewrites the current route and history entries when a note moves', () => {
      const { result } = routerHook()
      act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      act(() => result.current.navigate({ kind: 'allNotes', tag: null }))
      act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      const arrivalsBefore = result.current.arrivalSeq
      const entryBefore = result.current.entryId

      act(() => emitNoteMoved('notes/01abc.md', 'notes/meeting-notes.md'))

      // The current entry followed the file — a rewrite, not an arrival, on
      // the same entry (views keep their scroll; nothing re-anchors).
      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
      expect(result.current.arrivalSeq).toBe(arrivalsBefore)
      expect(result.current.entryId).toBe(entryBefore)

      // The earlier history entry followed too: back over the rename lands
      // on the file's real home, never the dead path.
      act(() => result.current.back())
      expect(result.current.route).toEqual({ kind: 'allNotes', tag: null })
      act(() => result.current.back())
      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
    })

    it('leaves unrelated routes untouched', () => {
      const { result } = routerHook()
      act(() => result.current.navigate({ kind: 'note', path: 'notes/other.md' }))

      act(() => emitNoteMoved('notes/01abc.md', 'notes/meeting-notes.md'))

      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/other.md' })
    })

    it('a move settling after the workspace unmounts is harmless', () => {
      const { result, unmount } = routerHook()
      act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      unmount()

      emitNoteMoved('notes/01abc.md', 'notes/meeting-notes.md')
    })
  })
})
