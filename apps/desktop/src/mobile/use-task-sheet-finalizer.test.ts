import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import {
  useTaskSheetFinalizer,
  type TaskSheetFinalizerDeps,
} from './use-task-sheet-finalizer'

/**
 * The quick-edit sheet's exit-rule state machine, tested directly — the
 * screen tests drive it through the drawer, but a mid-open live-row change
 * (a reindex rewriting the task) can't be staged through that harness, so
 * the frozen-baseline rule is pinned here.
 */

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  const text = overrides.text ?? 'alpha'
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
    raw: `[ ] ${text}`,
    checked: false,
    text,
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}

const edit = vi.fn()
const remove = vi.fn()
const onOpenChange = vi.fn()
const onReseed = vi.fn()

function deps(overrides: Partial<TaskSheetFinalizerDeps> = {}): TaskSheetFinalizerDeps {
  return {
    task: task(),
    open: true,
    onOpenChange,
    actions: { edit, remove },
    onReseed,
    ...overrides,
  }
}

beforeEach(() => {
  edit.mockReset()
  remove.mockReset()
  onOpenChange.mockReset()
  onReseed.mockReset()
})

describe('useTaskSheetFinalizer', () => {
  it('keeps the baseline frozen at open: a live-row rewrite does not turn an untouched draft into an edit', () => {
    const { result, rerender } = renderHook((props: TaskSheetFinalizerDeps) => useTaskSheetFinalizer(props), {
      initialProps: deps(),
    })

    // A reindex rewrites the row's content while the sheet stays open.
    rerender(deps({ task: task({ text: 'beta', raw: '[ ] beta' }) }))

    act(() => result.current.handleOpenChange(false))

    // The draft still reads "alpha" but so does the frozen baseline — this is
    // a cancel, not a commit of stale text over the external change.
    expect(edit).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('commits a changed draft on dismissal', () => {
    const { result } = renderHook(() => useTaskSheetFinalizer(deps()))

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.handleOpenChange(false))

    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]?.[1]).toBe('alpha edited')
  })

  it('deletes an emptied draft on dismissal', () => {
    const { result } = renderHook(() => useTaskSheetFinalizer(deps()))

    act(() => result.current.setDraft(''))
    act(() => result.current.handleOpenChange(false))

    expect(remove).toHaveBeenCalledTimes(1)
    expect(edit).not.toHaveBeenCalled()
  })

  it('deletes an abandoned-empty task on dismissal, but not on navigate', () => {
    const empty = task({ text: '', raw: '[ ] ' })

    const navigated = renderHook(() => useTaskSheetFinalizer(deps({ task: empty })))
    act(() => navigated.result.current.closeNavigate())
    expect(remove).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)

    const dismissed = renderHook(() => useTaskSheetFinalizer(deps({ task: empty })))
    act(() => dismissed.result.current.handleOpenChange(false))
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('commits a changed draft on navigate', () => {
    const { result } = renderHook(() => useTaskSheetFinalizer(deps()))

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.closeNavigate())

    expect(edit).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('commits once across a duplicate dismissal and the unmount flush', () => {
    const { result, unmount } = renderHook(() => useTaskSheetFinalizer(deps()))

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.handleOpenChange(false))
    // A second gesture callback before the parent re-renders, then the
    // unmount flush with the open prop still true — neither may double-write.
    act(() => result.current.handleOpenChange(false))
    unmount()

    expect(edit).toHaveBeenCalledTimes(1)
  })

  it('skips the dismissal commit after an action already handled the close', () => {
    const { result } = renderHook(() => useTaskSheetFinalizer(deps()))

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.closeHandled())
    // A dismissal callback racing the programmatic close must not double-write.
    act(() => result.current.handleOpenChange(false))

    expect(edit).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('reseeds the draft, baseline, and presentation when the sheet reopens', () => {
    const { result, rerender } = renderHook(
      (props: TaskSheetFinalizerDeps) => useTaskSheetFinalizer(props),
      { initialProps: deps() },
    )

    act(() => result.current.setDraft('scratch'))
    act(() => result.current.closeHandled())
    rerender(deps({ open: false }))

    // Reopen for a row an action rewrote in the meantime.
    rerender(deps({ task: task({ text: 'rewritten', raw: '[ ] rewritten' }) }))

    expect(result.current.draft).toBe('rewritten')
    expect(onReseed).toHaveBeenCalledTimes(1)
    // The reseeded baseline makes the untouched reopen a cancel again.
    act(() => result.current.handleOpenChange(false))
    expect(edit).not.toHaveBeenCalled()
  })

  it('resolves against the live surface when readDraft is fresher than the mirrored state', () => {
    // An uncontrolled editor can hold a change whose onChange hasn't
    // re-rendered into the draft state yet — the commit must not drop it.
    const { result } = renderHook(() =>
      useTaskSheetFinalizer(deps({ readDraft: () => 'alpha typed live' })),
    )

    act(() => result.current.handleOpenChange(false))

    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]?.[1]).toBe('alpha typed live')
  })

  it('falls back to the mirrored draft when readDraft cannot answer', () => {
    const { result } = renderHook(() =>
      useTaskSheetFinalizer(deps({ readDraft: () => null })),
    )

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.handleOpenChange(false))

    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]?.[1]).toBe('alpha edited')
  })

  it('trusts readDraft during the unmount flush — a change-stream mirror has no teardown window', () => {
    // readDraft is contractually fed by the surface's own onChange stream
    // (never an imperative editor read), so its value — including a genuine
    // clear — is authoritative even while the tree unmounts.
    const { result, unmount } = renderHook(() =>
      useTaskSheetFinalizer(deps({ readDraft: () => 'alpha typed live' })),
    )

    act(() => result.current.setDraft('alpha edited'))
    unmount()

    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]?.[1]).toBe('alpha typed live')
  })

  it('treats an empty readDraft as a genuine clear', () => {
    // Under the change-stream contract '' can only mean the user emptied the
    // draft, so an abandoning dismissal deletes rather than resurrecting text.
    const { result } = renderHook(() =>
      useTaskSheetFinalizer(deps({ readDraft: () => '' })),
    )

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.handleOpenChange(false))

    expect(remove).toHaveBeenCalledTimes(1)
    expect(edit).not.toHaveBeenCalled()
  })

  it('flushes like a dismissal when unmounted under an open sheet', () => {
    const { result, unmount } = renderHook(() => useTaskSheetFinalizer(deps()))

    act(() => result.current.setDraft('alpha edited'))
    unmount()

    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]?.[1]).toBe('alpha edited')
  })

  it('does not flush on unmount when the sheet is closed', () => {
    const { result, rerender, unmount } = renderHook(
      (props: TaskSheetFinalizerDeps) => useTaskSheetFinalizer(props),
      { initialProps: deps() },
    )

    act(() => result.current.setDraft('alpha edited'))
    act(() => result.current.handleOpenChange(false))
    edit.mockReset()
    rerender(deps({ open: false }))
    unmount()

    expect(edit).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
