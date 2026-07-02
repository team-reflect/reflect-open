import { act, render, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { emitNoteMoved } from '@/lib/note-moves'
import type { Route } from './route'
import { RouterFreeze, RouterProvider, useRouter } from './router'

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

  it('can clear the active entry scroll offset without changing routes', () => {
    const { result } = routerHook()
    const entryId = result.current.entryId
    const arrivals = result.current.arrivalSeq
    act(() => result.current.saveScrollState(120))

    act(() => result.current.clearScrollState())

    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.entryId).toBe(entryId)
    expect(result.current.arrivalSeq).toBe(arrivals)
    expect(result.current.savedScroll()).toBeNull()
  })

  it('re-navigating to the current route clears its saved scroll (re-anchor intent)', () => {
    const { result } = routerHook()
    const seqBefore = result.current.arrivalSeq
    act(() => result.current.saveScrollState(500)) // user scrolled away on today
    act(() => result.current.navigate({ kind: 'today' })) // ⌘D while on today
    expect(result.current.savedScroll()).toBeNull() // re-anchor, don't restore
    expect(result.current.arrivalSeq).toBe(seqBefore + 1) // views are notified
  })

  it('can restore the daily surface scroll when a tab switch returns to today', () => {
    const { result } = routerHook()
    act(() => result.current.saveScrollState(500)) // user scrolled the daily stream
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))

    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.savedScroll()).toBe(500)
  })

  it('keeps default fresh navigations to daily routes anchor-only', () => {
    const { result } = routerHook()
    act(() => result.current.saveScrollState(500))
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    act(() => result.current.navigate({ kind: 'today' }))

    expect(result.current.savedScroll()).toBeNull()
  })

  it('a surface-scroll return from within the surface re-anchors instead', () => {
    const { result } = routerHook({ kind: 'daily', date: '2026-06-08' })
    act(() => result.current.saveScrollState(500)) // scrolled the stream on a dated day
    act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))
    expect(result.current.savedScroll()).toBeNull() // Daily tab on-stream = ⌘D re-anchor

    act(() => result.current.saveScrollState(300))
    act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))
    expect(result.current.savedScroll()).toBeNull() // same while already on today
  })

  it('an explicit re-anchor arrival drops the daily surface offset too', () => {
    const { result } = routerHook()
    act(() => result.current.saveScrollState(500)) // user scrolled away on today
    act(() => result.current.navigate({ kind: 'today' })) // ⌘D re-anchors the stream
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))

    expect(result.current.savedScroll()).toBeNull() // the tab can't resurrect pre-⌘D scroll
  })

  it('clearScrollState drops the daily surface offset too (new-note interaction)', () => {
    const { result } = routerHook()
    act(() => result.current.saveScrollState(500)) // scrolled the stream before ⌘N
    act(() => result.current.clearScrollState()) // note.new discards the stream offsets
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))

    act(() => result.current.back())
    expect(result.current.savedScroll()).toBeNull() // ⌘[ re-anchors to today

    act(() => result.current.saveScrollState(120)) // post-clear scrolling
    act(() => result.current.forward())
    act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))
    expect(result.current.savedScroll()).toBe(120) // the tab restores only the new offset
  })

  it('carries the focusEditor intent on the arrival that asked for it, one-shot', () => {
    const { result } = routerHook()
    expect(result.current.arrivalFocusEditor).toBe(false)

    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true }))
    expect(result.current.arrivalFocusEditor).toBe(true)

    // The next arrival overwrites the intent — it can never leak onto a
    // later, unrelated visit (the staleness class a keyed request store had).
    act(() => result.current.navigate({ kind: 'note', path: 'notes/b.md' }))
    expect(result.current.arrivalFocusEditor).toBe(false)
  })

  it('clears the focusEditor intent on history moves', () => {
    const { result } = routerHook()
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true }))
    act(() => result.current.back())
    expect(result.current.arrivalFocusEditor).toBe(false)

    act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.arrivalFocusEditor).toBe(false)
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

  it('RouterFreeze pins what a background subtree sees until it surfaces', () => {
    let router: ReturnType<typeof useRouter> | null = null
    function Capture(): null {
      router = useRouter()
      return null
    }
    function Probe(): ReactElement {
      const { route, arrivalSeq } = useRouter()
      return <div data-testid="frozen-probe">{`${route.kind}:${arrivalSeq}`}</div>
    }
    function Harness({ frozen }: { frozen: boolean }): ReactElement {
      return (
        <RouterProvider>
          <Capture />
          <RouterFreeze frozen={frozen}>
            <Probe />
          </RouterFreeze>
        </RouterProvider>
      )
    }

    const view = render(<Harness frozen={false} />)
    expect(view.getByTestId('frozen-probe').textContent).toBe('today:0')

    // Covered by a pushed note (the mobile stack hides it): navigations must
    // not reach it — the daily surface would read the arrivalSeq bump as a
    // re-arrival and re-anchor its scroll while hidden.
    view.rerender(<Harness frozen={true} />)
    act(() => router!.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(view.getByTestId('frozen-probe').textContent).toBe('today:0')

    // Surfacing again resumes the live value.
    view.rerender(<Harness frozen={false} />)
    expect(view.getByTestId('frozen-probe').textContent).toBe('note:1')
  })

  it('exposes the route back() would land on (the mobile stack peeks it)', () => {
    const { result } = routerHook()
    expect(result.current.backRoute).toBeNull()
    act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.backRoute).toEqual({ kind: 'today' })
    act(() => result.current.navigate({ kind: 'note', path: 'notes/b.md' }))
    expect(result.current.backRoute).toEqual({ kind: 'note', path: 'notes/a.md' })
    act(() => result.current.back())
    expect(result.current.backRoute).toEqual({ kind: 'today' })
    act(() => result.current.back())
    expect(result.current.backRoute).toBeNull()
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
