import { render, renderHook } from 'vitest-browser-react'
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
  it('starts on today with no history', async () => {
    const { result } = await routerHook()
    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.canBack).toBe(false)
    expect(result.current.canForward).toBe(false)
  })

  it('navigate pushes; back and forward traverse the stack', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })

    await act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
    expect(result.current.canForward).toBe(true)

    await act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.canForward).toBe(false)
  })

  it('navigating from a back position truncates the forward branch', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-07' }))
    await act(() => result.current.back())
    await act(() => result.current.navigate({ kind: 'search', query: 'x' }))
    expect(result.current.canForward).toBe(false)
    await act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('re-navigating to the current route is a no-op (no stack growth)', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    await act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.canBack).toBe(false)
  })

  it('back/forward at the edges are no-ops', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.back())
    expect(result.current.route).toEqual({ kind: 'today' })
    await act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'today' })
  })

  it('advances the synchronous navigation revision for every navigation intent', async () => {
    const { result, act } = await routerHook()
    const revision = result.current.navigationRevision
    const initial = revision()

    // Even a same-route re-arrival is an intent (initial route is today).
    await act(() => result.current.navigate({ kind: 'today' }))
    expect(revision()).toBe(initial + 1)
    await act(() => result.current.navigate({ kind: 'tasks' }))
    expect(revision()).toBe(initial + 2)
    await act(() => result.current.back())
    expect(revision()).toBe(initial + 3)
    await act(() => result.current.forward())
    expect(revision()).toBe(initial + 4)
  })

  it('boundary back/forward no-ops leave the navigation revision alone', async () => {
    const { result, act } = await routerHook()
    const revision = result.current.navigationRevision
    await act(() => result.current.navigate({ kind: 'tasks' }))
    const settled = revision()

    // Nothing ahead: a stray ⌘] must not cancel a pending link fallback.
    await act(() => result.current.forward())
    expect(revision()).toBe(settled)

    await act(() => result.current.back())
    expect(revision()).toBe(settled + 1)
    // Nothing behind either — same rule for ⌘[ at the history start.
    await act(() => result.current.back())
    expect(revision()).toBe(settled + 1)
  })

  it('restores a saved scroll offset on back/forward, per entry', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.saveScrollState(120)) // scrolling on today
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.savedScroll()).toBeNull() // fresh entry: no offset yet

    await act(() => result.current.saveScrollState(40))
    await act(() => result.current.back())
    expect(result.current.savedScroll()).toBe(120) // today's offset restored

    await act(() => result.current.forward())
    expect(result.current.savedScroll()).toBe(40) // the note's own offset
  })

  it('can clear the active entry scroll offset without changing routes', async () => {
    const { result, act } = await routerHook()
    const entryId = result.current.entryId
    const arrivals = result.current.arrivalSeq
    await act(() => result.current.saveScrollState(120))

    await act(() => result.current.clearScrollState())

    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.entryId).toBe(entryId)
    expect(result.current.arrivalSeq).toBe(arrivals)
    expect(result.current.savedScroll()).toBeNull()
  })

  it('re-navigating to the current route clears its saved scroll (re-anchor intent)', async () => {
    const { result, act } = await routerHook()
    const seqBefore = result.current.arrivalSeq
    await act(() => result.current.saveScrollState(500)) // user scrolled away on today
    await act(() => result.current.navigate({ kind: 'today' })) // ⌘D while on today
    expect(result.current.savedScroll()).toBeNull() // re-anchor, don't restore
    expect(result.current.arrivalSeq).toBe(seqBefore + 1) // views are notified
  })

  it('can restore the daily surface scroll when a tab switch returns to today', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.saveScrollState(500)) // user scrolled the daily stream
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    await act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))

    expect(result.current.route).toEqual({ kind: 'today' })
    expect(result.current.savedScroll()).toBe(500)
  })

  it('keeps default fresh navigations to daily routes anchor-only', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.saveScrollState(500))
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    await act(() => result.current.navigate({ kind: 'today' }))

    expect(result.current.savedScroll()).toBeNull()
  })

  it('a surface-scroll return from within the surface re-anchors instead', async () => {
    const { result, act } = await routerHook({ kind: 'daily', date: '2026-06-08' })
    await act(() => result.current.saveScrollState(500)) // scrolled the stream on a dated day
    await act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))
    expect(result.current.savedScroll()).toBeNull() // Daily tab on-stream = ⌘D re-anchor

    await act(() => result.current.saveScrollState(300))
    await act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))
    expect(result.current.savedScroll()).toBeNull() // same while already on today
  })

  it('an explicit re-anchor arrival drops the daily surface offset too', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.saveScrollState(500)) // user scrolled away on today
    await act(() => result.current.navigate({ kind: 'today' })) // ⌘D re-anchors the stream
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    await act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))

    expect(result.current.savedScroll()).toBeNull() // the tab can't resurrect pre-⌘D scroll
  })

  it('clearScrollState drops the daily surface offset too (new-note interaction)', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.saveScrollState(500)) // scrolled the stream before ⌘N
    await act(() => result.current.clearScrollState()) // note.new discards the stream offsets
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))

    await act(() => result.current.back())
    expect(result.current.savedScroll()).toBeNull() // ⌘[ re-anchors to today

    await act(() => result.current.saveScrollState(120)) // post-clear scrolling
    await act(() => result.current.forward())
    await act(() => result.current.navigate({ kind: 'today' }, { restoreSurfaceScroll: true }))
    expect(result.current.savedScroll()).toBe(120) // the tab restores only the new offset
  })

  it('carries the focusEditor intent on the arrival that asked for it, one-shot', async () => {
    const { result, act } = await routerHook()
    expect(result.current.arrivalFocusEditor).toBe(false)

    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true }))
    expect(result.current.arrivalFocusEditor).toBe(true)

    // The next arrival overwrites the intent — it can never leak onto a
    // later, unrelated visit (the staleness class a keyed request store had).
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/b.md' }))
    expect(result.current.arrivalFocusEditor).toBe(false)
  })

  it('clears the focusEditor intent on history moves', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }, { focusEditor: true }))
    await act(() => result.current.back())
    expect(result.current.arrivalFocusEditor).toBe(false)

    await act(() => result.current.forward())
    expect(result.current.route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(result.current.arrivalFocusEditor).toBe(false)
  })

  it('entryId is stable per entry and changes across back/forward', async () => {
    const { result, act } = await routerHook()
    const todayId = result.current.entryId
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    const noteId = result.current.entryId
    expect(noteId).not.toBe(todayId)
    await act(() => result.current.back())
    expect(result.current.entryId).toBe(todayId)
    await act(() => result.current.forward())
    expect(result.current.entryId).toBe(noteId)
  })

  it('RouterFreeze pins what a background subtree sees until it surfaces', async () => {
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

    const view = await render(<Harness frozen={false} />)
    await expect.element(view.getByTestId('frozen-probe')).toHaveTextContent('today:0')

    // Covered by a pushed note (the mobile stack hides it): navigations must
    // not reach it — the daily surface would read the arrivalSeq bump as a
    // re-arrival and re-anchor its scroll while hidden.
    await view.rerender(<Harness frozen={true} />)
    router!.navigate({ kind: 'note', path: 'notes/a.md' })
    await expect.element(view.getByTestId('frozen-probe')).toHaveTextContent('today:0')

    // Surfacing again resumes the live value.
    await view.rerender(<Harness frozen={false} />)
    await expect.element(view.getByTestId('frozen-probe')).toHaveTextContent('note:1')
  })

  it('exposes the route back() would land on (the mobile stack peeks it)', async () => {
    const { result, act } = await routerHook()
    expect(result.current.backRoute).toBeNull()
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.backRoute).toEqual({ kind: 'today' })
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/b.md' }))
    expect(result.current.backRoute).toEqual({ kind: 'note', path: 'notes/a.md' })
    await act(() => result.current.back())
    expect(result.current.backRoute).toEqual({ kind: 'today' })
    await act(() => result.current.back())
    expect(result.current.backRoute).toBeNull()
  })

  it('normalizes a malformed daily date to the today route on navigate', async () => {
    const { result, act } = await routerHook()
    // 2026-02-31 is well-formed but impossible — dailyPath would throw on it.
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-02-31' }))
    expect(result.current.route).toEqual({ kind: 'today' })
    // Normalization happens before the no-op check: re-navigating doesn't push.
    expect(result.current.canBack).toBe(false)
  })

  it('normalizes a malformed daily initial route to today', async () => {
    const { result } = await routerHook({ kind: 'daily', date: 'not-a-date' })
    expect(result.current.route).toEqual({ kind: 'today' })
  })

  it('keeps a real daily date intact', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-08' }))
    expect(result.current.route).toEqual({ kind: 'daily', date: '2026-06-08' })
  })

  it('drops scroll offsets for a truncated forward branch', async () => {
    const { result, act } = await routerHook()
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    await act(() => result.current.saveScrollState(99))
    await act(() => result.current.back())
    // Navigating from a back position truncates the branch holding notes/a.md.
    await act(() => result.current.navigate({ kind: 'search', query: 'x' }))
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.savedScroll()).toBeNull() // a new entry, not the old one
  })

  describe('note moves (Plan 17)', () => {
    it('rewrites the current route and history entries when a note moves', async () => {
      const { result, act } = await routerHook()
      await act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      await act(() => result.current.navigate({ kind: 'allNotes', tag: null }))
      await act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      const arrivalsBefore = result.current.arrivalSeq
      const entryBefore = result.current.entryId
      const revisionBefore = result.current.navigationRevision()

      await act(() => emitNoteMoved('notes/01abc.md', 'notes/meeting-notes.md'))

      // The current entry followed the file — a rewrite, not an arrival, on
      // the same entry (views keep their scroll; nothing re-anchors).
      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
      expect(result.current.arrivalSeq).toBe(arrivalsBefore)
      expect(result.current.entryId).toBe(entryBefore)
      expect(result.current.navigationRevision()).toBe(revisionBefore + 1)

      // The earlier history entry followed too: back over the rename lands
      // on the file's real home, never the dead path.
      await act(() => result.current.back())
      expect(result.current.route).toEqual({ kind: 'allNotes', tag: null })
      await act(() => result.current.back())
      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/meeting-notes.md' })
    })

    it('leaves unrelated routes untouched', async () => {
      const { result, act } = await routerHook()
      await act(() => result.current.navigate({ kind: 'note', path: 'notes/other.md' }))

      await act(() => emitNoteMoved('notes/01abc.md', 'notes/meeting-notes.md'))

      expect(result.current.route).toEqual({ kind: 'note', path: 'notes/other.md' })
    })

    it('a move settling after the workspace unmounts is harmless', async () => {
      const { result, act, unmount } = await routerHook()
      await act(() => result.current.navigate({ kind: 'note', path: 'notes/01abc.md' }))
      unmount()

      emitNoteMoved('notes/01abc.md', 'notes/meeting-notes.md')
    })
  })
})
